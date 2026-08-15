import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { forgeKindOfRemote, type ForgeKind } from '../server/forge/index.ts';
import { getHeadCommit, getRepoInfo } from '../server/git.ts';

/**
 * The bounded walk behind `GET /api/v1/projects/scan` — every git repository inside a folder the
 * user is about to add, offered as its own project row (spec
 * `.ai/specs/2026-08-14-nested-repos-as-projects.md`), **plus every non-git immediate child that
 * is a unit of work in its own right** (`.ai/specs/2026-08-15-import-all-folders-as-projects.md`).
 *
 * It lives here, beside the registry it feeds, rather than in `server/git.ts`: what it produces is
 * a list of candidate PROJECTS, and `git.ts` is the plumbing it calls.
 *
 * **A directory is a repo when it has a `.git` entry, and by nothing else.** Never
 * `git rev-parse --show-toplevel`, which walks UPWARD: run inside a plain directory that happens to
 * sit under a repo it answers with the ancestor, so probing that way would report `docs/` as being
 * the enclosing repo — right branch, right remote, wrong repo, no error anywhere. `.git` may be a
 * directory (normal clone) or a file (linked worktree, submodule), and a bare `stat` covers both,
 * which is the same test `workspace/projects.ts#computeProbe` uses to decide `not-git`.
 * `enrichNestedRepos` below is the only thing that calls `getRepoInfo`, and only on directories
 * this walk has already proven are repo roots — so the upward walk cannot fire there either.
 */

/** One discovered candidate project — a repo, or (since 2026-08-15) a plain directory. Kept named
 *  `NestedRepo` because the contract's `nestedRepoSchema` is published under that name and renaming
 *  it buys nothing; `isRepo` is what distinguishes the two kinds. `registered` is filled in by the
 *  route, which is what holds the registry. */
export interface NestedRepo {
  /** Absolute path of the repo root, as walked (not realpath'd — see `scanNestedRepos`). */
  path: string;
  /** Path relative to the scanned folder, POSIX-spelled: `chat`, `packages/tool`. The row label. */
  relPath: string;
  /** `basename(path)` — what the project would be NAMED once registered. */
  name: string;
  branch?: string;
  forge?: ForgeKind;
  /** Has a `.git` entry. `false` = a plain directory offered as a project, which runs IN PLACE,
   *  one task at a time (`workflows/run.ts`) — the fact the dialog's warning is about. */
  isRepo: boolean;
  /** Repos only, filled in by `enrichNestedRepos`. `false` = `.git` with no commit yet, where
   *  `git worktree add` succeeds and yields an EMPTY tree. */
  hasCommits?: boolean;
}

export interface NestedRepoScan {
  repos: NestedRepo[];
  /** True when `MAX_REPOS` capped the walk — for EITHER kind of row. Never present a partial list
   *  as a whole one: a silently short list looks exactly like "there is nothing else in there". */
  truncated: boolean;
}

/**
 * How deep below the scanned folder the walk goes. 3 covers the shapes that actually occur — a
 * workspace of checkouts (`~/code/<repo>`), a checkout of checkouts (`~/workspace/<repo>`), and one
 * more level for a `projects/<group>/<repo>` layout — without turning "add a folder" into a scan of
 * a home directory's entire subtree.
 */
export const MAX_DEPTH = 3;

/** Hard ceiling on rows. A picker cannot usefully render more, and past this the answer stops being
 *  a decision the user makes and becomes a list they accept. */
export const MAX_REPOS = 25;

/**
 * Directories the walk never descends into.
 *
 * Two kinds, deliberately in one list: build/dependency output that can contain thousands of
 * entries (and, in the case of `node_modules` and `vendor`, whole vendored git repos that are not
 * the user's projects), and `.git` itself, whose internals are never a project.
 */
export const PRUNED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.turbo',
  'coverage',
  '.cache',
];

/**
 * Agent task worktrees — never a project row.
 *
 * The first is cezar's own: `registerFolder` refuses one outright, so offering it would put a row
 * in the list that cannot be added. Matched on the path, the same marker
 * `workspace/projects.ts` uses.
 *
 * The second is Claude Code's, and it is the one that bites in practice. Measured on
 * one real workspace folder: ten genuine repos and **six** `.claude/worktrees/<generated-name>` checkouts, every
 * one of them a linked worktree of a repo already in the list. They are not refused by
 * `registerFolder`, so nothing downstream catches them — and the dialog pre-checks every addable
 * row, so accepting the proposal wholesale registered six throwaway checkouts of the same project
 * under names like `sunny-riding-cat`, which vanish when the agent finishes.
 *
 * Matched on the path rather than by adding `.claude` to `PRUNED_DIRS`: that directory also holds
 * skills and settings a future walk may want, and pruning the whole thing to solve one subdirectory
 * is a wider rule than the reason for it.
 */
const WORKTREE_MARKERS: readonly string[] = [
  `${sep}.ai${sep}cezar${sep}worktrees${sep}`,
  `${sep}.claude${sep}worktrees${sep}`,
];

function isInsideTaskWorktree(path: string): boolean {
  const probe = `${path}${sep}`;
  return WORKTREE_MARKERS.some((marker) => probe.includes(marker));
}

async function isRepoRoot(dir: string): Promise<boolean> {
  try {
    await stat(join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Every git repository under `root` (breadth-first, bounded by `MAX_DEPTH`, `PRUNED_DIRS` and
 * `MAX_REPOS`), plus every non-git IMMEDIATE child of `root` that is not merely a container for
 * those repositories.
 *
 * `root` itself is NOT included even when it is a repo: the folder the user picked is already the
 * dialog's own row, and returning it here would make the same folder two proposals.
 *
 * Breadth-first rather than depth-first so that the cap, when it bites, keeps the SHALLOWEST repos
 * — the ones a user scanning `~/workspace` actually means. A depth-first walk truncated at 25 would
 * keep whatever happened to be under the alphabetically-first child.
 *
 * Paths are returned as walked. Realpath normalization is `registerProject`'s job and it does it on
 * every root it stores, so doing it here as well would only decide WHICH spelling reaches a user's
 * screen — and the walked spelling is the one their filesystem reads like.
 *
 * ## The folder rows (2026-08-15)
 *
 * Three rules decide them, and each one is load-bearing:
 *
 * 1. **Immediate children only**, while repos keep the depth-3 walk. Deliberately asymmetric: a
 *    `.git` entry is positive evidence that a directory is a unit of work, and it is what makes a
 *    deep hit trustworthy. A plain directory carries no such evidence, so at depth 3 every `src`,
 *    `docs` and `assets` under every non-repo child would become a checkbox and the list would stop
 *    being a decision the user makes.
 * 2. **Nothing when `root` is a repo that holds no other repos.** Its subdirectories are parts of
 *    that repo, not sibling projects — the same fact the 2026-08-14 negative control pins for
 *    `brand/` inside a checkout. A repo that DOES hold nested repos is a workspace folder that
 *    happens to be tracked (a directory of checkouts with a couple of doctrine files committed at
 *    the top), and its plain children are units of work like any other.
 *
 *    Measured on the workspace this feature was built for, 2026-08-15 — the rule is the
 *    measurement, not a guess:
 *
 *    | scanned folder | nested repos | plain children it would offer |
 *    |---|---|---|
 *    | the workspace folder (tracked) | 10 | `brand`, `design-assets`, … — every one real work |
 *    | `chat` (a checkout) | 0 | `domains`, `infra`, `packages`, `tools` — every one noise |
 *    | `cezar` (a checkout) | 0 | `docs`, `packages`, `scripts` — every one noise |
 *
 *    Both halves matter. Without the relaxation the feature misses its own motivating case; without
 *    the "holds no other repos" half it turns every checkout's source tree into pre-checked project
 *    rows.
 * 3. **No discovered repo beneath it.** Without this, a container like `~/code` whose whole content
 *    is the five repos already listed is offered as a sixth project that owns all five. A prefix
 *    test over the repos this walk already collected: no second walk, no extra syscalls.
 *
 * Hidden directories are skipped as folder rows (never as repos — a repo under `.claude` is still a
 * repo, which is the 2026-08-14 positive control). A dot-directory is configuration or tool state by
 * convention, which is also why the folder picker hides them by default; offering `.vscode` and
 * `.ai` as projects would bury the rows that matter.
 */
export async function scanNestedRepos(root: string): Promise<NestedRepoScan> {
  const repos: NestedRepo[] = [];
  const folders: NestedRepo[] = [];
  let truncated = false;
  let frontier: string[] = [root];
  // Rule 2 above, asked once, before anything is collected.
  const rootIsRepo = await isRepoRoot(root);

  for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of frontier) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
      // Unreadable (permissions, a vanished directory mid-walk) — skipped, never fatal. One
      // unreadable subtree must not cost the user the rest of the list.
      if (entries === null) continue;
      for (const entry of entries) {
        // Symlinks are deliberately not followed. A symlinked directory is a legitimate setup for a
        // PROJECT (the picker lists them), but following one here can leave the scanned tree
        // entirely, and a link back to an ancestor turns a bounded walk into a loop that only
        // `MAX_DEPTH` stops.
        if (!entry.isDirectory()) continue;
        if (PRUNED_DIRS.includes(entry.name)) continue;
        const childPath = join(dir, entry.name);
        if (isInsideTaskWorktree(childPath)) continue;
        if (await isRepoRoot(childPath)) {
          if (repos.length >= MAX_REPOS) {
            truncated = true;
            continue;
          }
          repos.push(row(root, childPath, true));
          // Do NOT descend: a submodule or a vendored checkout inside a repo is part of that repo,
          // not a sibling project. This is also what keeps a monorepo from multiplying into rows.
          continue;
        }
        // A folder CANDIDATE — kept whole, filtered after the walk, because neither "does a repo
        // live under this" nor "is this folder a workspace" can be answered until the walk that
        // finds the repos has finished.
        if (depth === 0 && !entry.name.startsWith('.')) {
          folders.push(row(root, childPath, false));
        }
        next.push(childPath);
      }
    }
    frontier = next;
  }

  // Rule 3, plus D3's ordering. Repos fill the cap first, so a folder row can only ever be emitted
  // from a COMPLETE repo list: when the repo walk truncated, `repos.length === MAX_REPOS` and the
  // budget below is zero. That is what keeps this filter from being evaluated against a repo list
  // missing exactly the entry that would have filtered a container out.
  const containsARepo = (folder: NestedRepo): boolean =>
    repos.some((repo) => repo.path.startsWith(`${folder.path}${sep}`));
  // Rule 2: a repo holding no other repos is a checkout, and a checkout's subdirectories are its
  // own, never projects.
  const isPlainCheckout = rootIsRepo && repos.length === 0;
  const offerable = (isPlainCheckout ? [] : folders)
    .filter((folder) => !containsARepo(folder))
    // readdir order is not sorted on every filesystem, and the cap has to bite deterministically:
    // which folders survive it must not depend on inode order.
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
  const budget = Math.max(0, MAX_REPOS - repos.length);
  if (offerable.length > budget) truncated = true;

  return { repos: [...repos, ...offerable.slice(0, budget)], truncated };
}

function row(root: string, path: string, isRepo: boolean): NestedRepo {
  return {
    path,
    relPath: relative(root, path).split(sep).join('/'),
    name: basename(path),
    isRepo,
  };
}

/**
 * Fill in `branch`, `forge` and `hasCommits` for each discovered repo.
 *
 * Separate from the walk, and not folded into it, for two reasons: the walk stays free of process
 * spawning (so its tests need no git), and this is the part with a real cost — one `getRepoInfo`
 * per repo, each of which shells out to `git` three times. Bounded by `MAX_REPOS`, run with a small
 * concurrency window rather than all at once, since 25 simultaneous git invocations is a spike on a
 * laptop for no latency benefit.
 *
 * Best-effort throughout: `getRepoInfo` answers `null` rather than throwing (an unborn HEAD, a
 * repo mid-clone), and a repo with neither branch nor remote is still a perfectly good row.
 *
 * **A folder row is skipped entirely** — no git process is spawned for a directory with no `.git`.
 * Not just a saving: `getRepoInfo` walks UPWARD, so run inside a plain directory that sits under a
 * repo it answers with the ANCESTOR's branch and remote, and the row would render a branch that is
 * not its own.
 *
 * `hasCommits` is asked with `getHeadCommit` rather than inferred from `getRepoInfo` returning
 * `null`: that null has several causes (no `.git` at all, a repo mid-clone, an unreadable one), and
 * a status this consequential — it is the difference between an isolated worktree and an empty one
 * — must not be derived from an ambiguous signal.
 */
export async function enrichNestedRepos(repos: NestedRepo[], concurrency = 4): Promise<NestedRepo[]> {
  const out = [...repos];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const repo = out[index];
      if (repo === undefined) return;
      if (!repo.isRepo) continue;
      const info = await getRepoInfo(repo.path).catch(() => null);
      const forge = forgeKindOfRemote(info?.remote);
      const head = await getHeadCommit(repo.path).catch(() => null);
      out[index] = {
        ...repo,
        ...(info?.branch ? { branch: info.branch } : {}),
        ...(forge ? { forge } : {}),
        hasCommits: head !== null,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, out.length) }, worker));
  return out;
}
