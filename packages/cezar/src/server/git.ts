import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface RepoInfo {
  root: string;
  branch: string;
  remote?: string;
}

export interface StatusEntry {
  status: string;
  path: string;
}

export interface LogEntry {
  hash: string;
  subject: string;
  author: string;
  when: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/** Null when `dir` isn't inside a git repository. */
export async function getRepoInfo(dir: string): Promise<RepoInfo | null> {
  try {
    const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    let remote: string | undefined;
    try {
      remote = (await git(root, ['remote', 'get-url', 'origin'])).trim() || undefined;
    } catch {
      // No remote named `origin` — fall back to the first configured remote,
      // so repos whose only remote is named e.g. `github` or `upstream` still
      // get forge detection. Truly remote-less repos land in the inner catch.
      try {
        const names = (await git(root, ['remote'])).split('\n').map((n) => n.trim()).filter(Boolean);
        if (names[0]) {
          remote = (await git(root, ['remote', 'get-url', names[0]])).trim() || undefined;
        }
      } catch {
        // no remotes at all — local-only repo
      }
    }
    return { root, branch, remote };
  } catch {
    return null;
  }
}

/** The current commit, pinned as a full SHA. Null outside a repository or before its first commit. */
export async function getHeadCommit(root: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim() || null;
  } catch {
    return null;
  }
}

export async function getStatus(root: string): Promise<StatusEntry[]> {
  const out = await git(root, ['status', '--porcelain']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || '??', path: line.slice(3) }));
}

/** Working-tree diff vs HEAD (staged + unstaged), capped for the GUI. */
export async function getDiff(root: string, cap = 400_000): Promise<string> {
  const diff = await git(root, ['diff', 'HEAD']);
  if (diff.length > cap) return `${diff.slice(0, cap)}\n… (diff truncated)`;
  return diff;
}

/** Local + origin branch names, deduped (origin/x counts as x), sorted.
 *  Feeds the Repo tab's base-branch picker. */
export async function getBranches(root: string): Promise<string[]> {
  const names = new Set<string>();
  try {
    const local = await git(root, ['branch', '--list', '--format=%(refname:short)']);
    for (const line of local.split('\n')) {
      const name = line.trim();
      if (name) names.add(name);
    }
  } catch {
    // no branches — empty list
  }
  try {
    const remote = await git(root, ['branch', '-r', '--list', '--format=%(refname:short)']);
    for (const line of remote.split('\n')) {
      const name = line.trim();
      if (!name || name.includes('HEAD')) continue;
      names.add(name.replace(/^origin\//, ''));
    }
  } catch {
    // no remotes — local only
  }
  return [...names].filter((n) => !n.startsWith('cez/')).sort((a, b) => a.localeCompare(b));
}

/** One commit — message + stat + patch — for the Repo view's expandable rows. */
export async function getCommit(root: string, sha: string, cap = 200_000): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return '(not a commit hash)';
  const out = await git(root, ['show', '--stat', '--patch', '--no-color', sha]);
  if (out.length > cap) return `${out.slice(0, cap)}\n… (diff truncated)`;
  return out;
}

export async function getLog(root: string, count = 20): Promise<LogEntry[]> {
  const out = await git(root, [
    'log',
    `-${count}`,
    '--pretty=format:%h%x1f%s%x1f%an%x1f%cr',
  ]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', subject = '', author = '', when = ''] = line.split('\x1f');
      return { hash, subject, author, when };
    });
}

export interface RepoDirtyCounts {
  staged: number;
  unstaged: number;
  untracked: number;
}

/** Everything `getRepoSummary` can read off `status --porcelain=v1 --branch`'s header line, the
 *  branch/upstream/ahead-behind half of the summary. `ahead`/`behind` are set ONLY when there is
 *  an upstream to compare against — absent (never `0`) for a branch with none, since "no upstream"
 *  and "level with upstream" are different facts (the workspace git overview spec, D2/verification
 *  table). When an upstream exists but git reports `[gone]` (its remote-tracking ref no longer
 *  exists), the same rule applies: no count can honestly be made, so both stay absent even though
 *  `upstream` itself is still reported. */
export interface RepoBranchInfo {
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

export interface RepoSummary extends RepoBranchInfo {
  dirty: RepoDirtyCounts;
  head?: LogEntry;
}

/** Parses one `git status --porcelain=v1 --branch` header line. The five shapes it can take:
 *  `## HEAD (no branch)` (detached), `## No commits yet on <branch>` (unborn), `## <branch>`
 *  (no upstream), `## <branch>...<upstream>` (level), and `## <branch>...<upstream> [ahead N[,
 *  behind M]]` / `[behind M]` / `[gone]`. */
function parseBranchHeader(header: string): RepoBranchInfo {
  const rest = header.startsWith('## ') ? header.slice(3) : header;
  if (rest === 'HEAD (no branch)') return { detached: true };
  // An unborn branch REPORTS its name. `head` is already absent here, and that is what carries
  // "nothing committed yet" — `branch: main` with no head is strictly more informative than
  // reporting neither. Corrected 2026-08-14: the spec first said `branch` was absent on both a
  // detached HEAD and an unborn branch, which over-applied the ahead/behind rule. Absence should
  // mean "we cannot say", and here we can — git prints the name right there in the header. After
  // this, an absent `branch` means exactly one thing: a detached HEAD.
  const unborn = /^No commits yet on (.+)$/.exec(rest);
  if (unborn) return { branch: unborn[1] };

  let body = rest;
  let bracket: string | undefined;
  const withBracket = /^(.*) \[([^\]]+)\]$/.exec(body);
  if (withBracket) {
    body = withBracket[1]!;
    bracket = withBracket[2];
  }

  // Split on the FIRST `...` rather than matching branch/upstream names with a character class:
  // both can legally contain dots (`release/1.0`), so a class-based split would mis-parse them.
  const sep = body.indexOf('...');
  const branch = sep === -1 ? body : body.slice(0, sep);
  const upstream = sep === -1 ? undefined : body.slice(sep + 3);

  const info: RepoBranchInfo = { branch };
  if (!upstream) return info;
  info.upstream = upstream;
  if (bracket === 'gone') return info; // upstream ref is gone — no count can be made
  const aheadMatch = bracket ? /ahead (\d+)/.exec(bracket) : null;
  const behindMatch = bracket ? /behind (\d+)/.exec(bracket) : null;
  // An upstream IS a comparison, so "no bracket" / "no ahead token" means the honest answer is 0,
  // not absent — absence is reserved for "there is nothing to compare against" (no upstream at all).
  info.ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
  info.behind = behindMatch ? Number(behindMatch[1]) : 0;
  return info;
}

/** Classifies each `status --porcelain=v1` entry line by its XY code. A path can count in both
 *  `staged` and `unstaged` at once (e.g. `MM`: staged then further modified) — that is not a bug,
 *  it is the same file carrying two real facts. */
function classifyDirty(entries: readonly string[]): RepoDirtyCounts {
  const counts: RepoDirtyCounts = { staged: 0, unstaged: 0, untracked: 0 };
  for (const line of entries) {
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    if (x === '?' && y === '?') {
      counts.untracked++;
      continue;
    }
    if (x !== ' ') counts.staged++;
    if (y !== ' ') counts.unstaged++;
  }
  return counts;
}

/**
 * The workspace git overview's per-project row (`.ai/specs/2026-08-14-cross-project-git-overview.md`,
 * D2) — TWO `git` spawns for what `getRepoInfo` + `getStatus` + `getLog` together cost 4-6:
 *
 *   `git status --porcelain=v1 --branch`               → branch, upstream, ahead/behind, dirty
 *   `git log -1 --pretty=%h%x1f%s%x1f%an%x1f%cr`        → last commit
 *
 * `remote` is deliberately not part of this summary (D2) — the overview does not show it, and
 * forge identity already rides `ProjectListEntry.forge`. Rejects (rather than degrading to a
 * partial answer) when `status` fails — a missing root, a non-git root, or any other `git`
 * failure — so the caller (`workspace/git-index.ts`) is the one place that decides how a failed
 * row reads to the workspace overview. `git log -1` failing alone (an unborn branch has no commit
 * yet) is NOT a failure of the whole summary: `head` is simply absent.
 */
export async function getRepoSummary(root: string): Promise<RepoSummary> {
  const [statusOut, logOut] = await Promise.all([
    git(root, ['status', '--porcelain=v1', '--branch']),
    git(root, ['log', '-1', '--pretty=format:%h%x1f%s%x1f%an%x1f%cr']).catch(() => ''),
  ]);

  const lines = statusOut.split('\n').filter((line) => line.length > 0);
  const [header, ...entries] = lines;
  const branchInfo = header ? parseBranchHeader(header) : {};
  const dirty = classifyDirty(entries);

  const trimmedLog = logOut.trim();
  let head: LogEntry | undefined;
  if (trimmedLog) {
    const [hash = '', subject = '', author = '', when = ''] = trimmedLog.split('\x1f');
    head = { hash, subject, author, when };
  }

  return { ...branchInfo, dirty, head };
}
