import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { getHeadCommit, getRepoInfo } from '../server/git.ts';

const exec = promisify(execFile);

/**
 * "Set up git" — what turns a folder offered by `GET /api/v1/projects/scan` into a project that
 * can actually run tasks in parallel (spec `.ai/specs/2026-08-15-import-all-folders-as-projects.md`,
 * D4/D5).
 *
 * ## Why this is init AND a first commit, never init alone
 *
 * Measured on 2026-08-15, git 2.50.1:
 *
 * | repo state | `git worktree add` | worktree contents |
 * |---|---|---|
 * | `git init`, no commits | succeeds (git infers `--orphan`) | **empty — none of your files** |
 * | after a first commit | succeeds | your files |
 *
 * So a button that stopped at `git init` would trade cezar's honest "not a git repository — running
 * in place, one task at a time" note for agents working in an EMPTY directory, on a project
 * `computeProbe` would then call healthy. Loud and correct, replaced by silent and wrong. The
 * commit is not a nicety; it is the entire point of the button.
 *
 * ## Two different answers to two different hazards (D5)
 *
 * - **A detected secret is EXCLUDED.** `.gitignore` is written before `git add -A`, so the file is
 *   never staged, never in the object database, never in a commit somebody would later have to
 *   rewrite history to remove. Every exclusion is named in the response.
 * - **An oversized file REFUSES the whole operation.** Nothing is written at all. Auto-ignoring it
 *   would be cezar deciding a 40 MB asset is not part of the user's project — not cezar's decision
 *   — and committing it blind would put it in history forever. The user resolves it and clicks
 *   again.
 *
 * The same asymmetry governs `truncated`: cezar commits only what it has fully inspected, so a tree
 * too large to inspect is refused rather than committed on the strength of a partial scan.
 *
 * ## Nothing here trusts a preflight it was handed
 *
 * `initGitRepo` runs `preflightGitInit` itself. The HTTP layer takes a path and nothing else,
 * because a caller able to hand back `sensitive: []` is a caller able to decide to commit your
 * `.env`.
 */

/** A file this size or larger refuses the operation. 10 MB is roughly where git itself starts
 *  warning, and well below it nothing surprising happens to a clone. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * The inspection ceiling. Past this the walk stops and `truncated` is set — and `initGitRepo`
 * refuses, rather than committing a tree whose remainder it never looked at. A folder this size is
 * almost always dependency output that wants a `.gitignore` written by a human anyway.
 */
export const MAX_SCANNED_FILES = 50_000;

/**
 * File names that are secrets by convention. Matched on the NAME, at any depth.
 *
 * Deliberately a conservative list of things that are secrets essentially always, not a
 * heuristic scan of file contents: a false positive here silently drops a file the user meant to
 * commit, and the response naming it is the only signal they get. Content scanning belongs to a
 * real secret scanner, not to a one-click button.
 */
const SENSITIVE_NAMES: readonly string[] = [
  '.env',
  '.envrc',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.dev.vars',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
  'service-account.json',
  'secrets.json',
];

/** Extensions that carry private keys and signing material. */
const SENSITIVE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.ppk'];

/** `.env.local`, `.env.production` — the spelling nearly every framework uses. */
function isSensitiveName(name: string): boolean {
  if (SENSITIVE_NAMES.includes(name)) return true;
  if (name.startsWith('.env.')) return true;
  return SENSITIVE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
}

export interface GitInitPreflight {
  /** The path as given — the route hands in an already-resolved one. */
  path: string;
  /** Has a `.git` entry. With `hasCommits: false` this is the repair case. */
  alreadyRepo: boolean;
  /** A commit exists. `alreadyRepo && hasCommits` ⇒ nothing for the button to do. */
  hasCommits: boolean;
  /** An ANCESTOR is a git repo and this folder is not it. On its own this is a NOTE, not a
   *  refusal — see `trackedElsewhere`. */
  insideRepo: boolean;
  /** That ancestor repo already TRACKS files in here. This is the refusal: the same files would
   *  live in two repositories at once, and every commit either one made would be a lie about the
   *  other. An ancestor that ignores (or simply does not track) this folder is not that case. */
  trackedElsewhere: boolean;
  /** Files that would be committed — sensitive and oversized ones excluded. */
  files: number;
  bytes: number;
  /** Relative POSIX paths that go into `.gitignore` instead of the commit. */
  sensitive: string[];
  /** `path (12.4 MB)`-spelled. Non-empty ⇒ `initGitRepo` refuses and writes nothing. */
  oversized: string[];
  /** The walk hit `MAX_SCANNED_FILES`. `files`/`bytes` are a floor, and `initGitRepo` refuses. */
  truncated: boolean;
}

/** Everything `initGitRepo` did, read back from git rather than assumed. */
export interface GitInitOutcome {
  path: string;
  branch: string;
  commit: string;
  files: number;
  ignored: string[];
}

export type GitInitResult =
  | { ok: true; body: GitInitOutcome }
  | { ok: false; status: 400 | 500; error: string };

/** `12.4 MB`. Sizes are for a human deciding whether to go and look at the file. */
function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const posix = (root: string, path: string): string => relative(root, path).split(sep).join('/');

/**
 * What "Set up git" WOULD do. Reads only.
 *
 * The walk skips `.git` (its internals are never user content) and does not follow directory
 * symlinks — the same reason `scanNestedRepos` does not: a link back to an ancestor turns a bounded
 * walk into a loop. A symlink is still COUNTED (git commits it as a link) and still name-checked for
 * sensitivity, so a `.env` symlinked from elsewhere is excluded like a real one.
 */
export async function preflightGitInit(path: string): Promise<GitInitPreflight> {
  const alreadyRepo = await stat(join(path, '.git')).then(() => true).catch(() => false);
  const hasCommits = alreadyRepo ? (await getHeadCommit(path).catch(() => null)) !== null : false;
  const insideRepo = alreadyRepo ? false : await isInsideRepo(path);
  // `git ls-files` run INSIDE the folder lists what the enclosing repo tracks under it, relative to
  // the folder — so an empty answer is exactly "the outer repo has nothing here".
  const trackedElsewhere = insideRepo ? (await git(path, ['ls-files']).catch(() => '')).trim() !== '' : false;

  let files = 0;
  let bytes = 0;
  let scanned = 0;
  let truncated = false;
  const sensitive: string[] = [];
  const oversized: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    if (truncated) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    // Unreadable subtree: counted as nothing rather than fatal. `git add -A` will hit the same
    // permission error and say so with git's own words.
    if (entries === null) return;
    for (const entry of entries) {
      if (truncated) return;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        await walk(child);
        continue;
      }
      scanned += 1;
      if (scanned > MAX_SCANNED_FILES) {
        truncated = true;
        return;
      }
      const rel = posix(path, child);
      if (isSensitiveName(entry.name)) {
        sensitive.push(rel);
        continue;
      }
      // `lstat`, not `stat`: the size that matters is the object git will write, and for a symlink
      // that is the link itself, not the (possibly enormous, possibly absent) target.
      const info = await lstat(child).catch(() => null);
      if (info === null) continue;
      if (info.size >= MAX_FILE_BYTES) {
        oversized.push(`${rel} (${human(info.size)})`);
        continue;
      }
      files += 1;
      bytes += info.size;
    }
  };
  await walk(path);

  return {
    path,
    alreadyRepo,
    hasCommits,
    insideRepo,
    trackedElsewhere,
    files,
    bytes,
    sensitive,
    oversized,
    truncated,
  };
}

/** Is an ANCESTOR of `dir` a git repository? `git rev-parse --show-toplevel` is exactly the upward
 *  walk every other call site in this codebase avoids — here it is the question being asked, and
 *  the answer is compared against `dir` itself so "this folder is the repo" is not mistaken for
 *  "this folder is inside one". */
async function isInsideRepo(dir: string): Promise<boolean> {
  const info = await getRepoInfo(dir).catch(() => null);
  if (info === null) return false;
  const [top, here] = await Promise.all([realpathOrSelf(info.root), realpathOrSelf(dir)]);
  return top !== here;
}

async function realpathOrSelf(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

/**
 * `git init -b main` → `.gitignore` → `git add -A` → `git commit`, refusing on anything from D5.
 *
 * The order is the guarantee: an exclusion written after `git add` would be an exclusion that does
 * not exclude, and the file would already be staged.
 */
export async function initGitRepo(path: string): Promise<GitInitResult> {
  const pre = await preflightGitInit(path);

  if (pre.alreadyRepo && pre.hasCommits) {
    return { ok: false, status: 400, error: 'this folder is already a git repository with commits' };
  }
  // `insideRepo` alone is NOT a refusal, and the distinction was measured (2026-08-15). The
  // workspace this feature was built for is itself a git repo — two doctrine files at the top of a
  // directory that already holds ten independent checkouts — and its non-git folders are exactly
  // the rows this button exists for. Refusing "a repo inside a repo" outright would have refused
  // every one of them, on the one machine the feature had to work on.
  //
  // What IS refused is an outer repo that already TRACKS these files: two repositories over one set
  // of files, where each one's history is a lie about the other. The enclosing repo is deliberately
  // not named — it can sit above the browse root, and a path above the root is what containment
  // exists to keep out of a response.
  if (pre.trackedElsewhere) {
    return {
      ok: false,
      status: 400,
      error: 'the git repository above this folder already tracks these files',
    };
  }
  if (pre.truncated) {
    return {
      ok: false,
      status: 400,
      error: `this folder holds more than ${MAX_SCANNED_FILES.toLocaleString('en-US')} files — too many to check for secrets, so cezar will not commit it blind`,
    };
  }
  if (pre.oversized.length > 0) {
    const named = pre.oversized.slice(0, 3).join(', ');
    const rest = pre.oversized.length > 3 ? ` and ${pre.oversized.length - 3} more` : '';
    return {
      ok: false,
      status: 400,
      error: `refusing to commit a file over ${human(MAX_FILE_BYTES)}: ${named}${rest} — ignore or move it, then try again`,
    };
  }

  try {
    if (!pre.alreadyRepo) await initRepo(path);
    const ignored = await writeGitignore(path, pre.sensitive);
    await git(path, ['add', '-A']);
    await commit(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 500, error: `git setup failed: ${firstLine(message)}` };
  }

  // Read the result back out of git rather than reporting what we asked for. The one thing this
  // endpoint must never do is answer with a commit that is not there — that is the commitless state
  // it exists to prevent, reported as success.
  const commitSha = await getHeadCommit(path).catch(() => null);
  const info = await getRepoInfo(path).catch(() => null);
  if (commitSha === null || info === null) {
    return { ok: false, status: 500, error: 'git setup ran but the repository has no commit — left as is' };
  }
  const tracked = await git(path, ['ls-files']).catch(() => '');
  return {
    ok: true,
    body: {
      path,
      branch: info.branch,
      commit: commitSha,
      files: tracked.split('\n').filter(Boolean).length,
      ignored: pre.sensitive,
    },
  };
}

/** `git init -b main`, with a fallback for git older than 2.28 where `-b` does not exist. */
async function initRepo(path: string): Promise<void> {
  try {
    await git(path, ['init', '-b', 'main']);
  } catch {
    await git(path, ['init']);
    await git(path, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
}

/**
 * Create or append `.gitignore` with one anchored entry per detected secret, and answer with the
 * lines actually written.
 *
 * Anchored (`/config/.env`) rather than bare (`.env`): the entry must exclude the file that was
 * found and nothing else. A bare `.env` in a repo root ignores every `.env` at every depth, which
 * is a broader rule than the evidence supports.
 *
 * Entries already present are not repeated — appending duplicates to a `.gitignore` the user
 * already curated is noise in a file they own.
 */
async function writeGitignore(path: string, sensitive: string[]): Promise<string[]> {
  if (sensitive.length === 0) return [];
  const file = join(path, '.gitignore');
  const existing = await readFile(file, 'utf8').catch(() => '');
  const present = new Set(existing.split('\n').map((line) => line.trim()));
  const additions = sensitive.map((rel) => `/${rel}`).filter((line) => !present.has(line));
  if (additions.length === 0) return sensitive;
  const header = '# added by cezar — detected secrets, excluded from the first commit';
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(file, `${existing}${prefix}${header}\n${additions.join('\n')}\n`, 'utf8');
  return sensitive;
}

/**
 * The first commit.
 *
 * `--allow-empty` because a folder whose entire content was excluded (or an empty one) must still
 * end with a commit — a commitless repo is the exact trap this whole module exists to avoid, and
 * "we initialized it but there was nothing to commit" walks straight into it.
 *
 * `--no-verify` and `commit.gpgsign=false` because a global hook path or a signing key with a
 * passphrase would otherwise hang or fail a one-click setup on a machine-wide setting that has
 * nothing to do with this repository. The identity fallback is for the same class of reason: a
 * machine with no `user.email` configured is a normal machine, not an error to report.
 */
async function commit(path: string): Promise<void> {
  const configured = await git(path, ['config', '--get', 'user.email'])
    .then((out) => out.trim() !== '')
    .catch(() => false);
  const identity = configured
    ? []
    : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@localhost'];
  await git(path, [
    ...identity,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '--no-verify',
    '-m',
    'initial commit',
  ]);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** git's failures are multi-line and end with a usage dump; the first line is the reason. */
function firstLine(message: string): string {
  return message.split('\n').find((line) => line.trim() !== '')?.trim() ?? message;
}
