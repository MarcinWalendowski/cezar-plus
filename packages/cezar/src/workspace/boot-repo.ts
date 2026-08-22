import { execFile } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getHeadCommit, getRepoInfo } from '../server/git.ts';

const exec = promisify(execFile);

/**
 * The boot/scratch root becomes a real git repository, so a task homed there can be isolated
 * instead of running in place under an exclusive working-tree lease
 * (`.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`, change A).
 *
 * ## The defect this exists to remove
 *
 * cezar's boot root — `/var/lib/cezar/workspace` on the hosted box, the `WorkingDirectory` of the
 * systemd unit — has never been a git repository. Measured on 2026-08-21, a run homed there
 * without a workspace grant emitted both of these and meant them:
 *
 * ```
 * · not a git repository — running in place, one task at a time
 * · waiting for exclusive access to the repository working tree
 * ```
 *
 * The first is `run.ts`'s non-git `else`; the second is the repository-root lease. Together they
 * cap the boot root at ONE run at a time, workspace-wide, with `maxParallel` still reading 5 in
 * Settings. Run `50ce87f1` held that lease for 85 minutes. Neither note is a bug on its own —
 * both are the correct degradation for a genuinely non-git PROJECT. They are wrong only here,
 * for a scratch root that holds no work and therefore has nothing to protect.
 *
 * ## Why this is init AND a first commit, never init alone
 *
 * `git-init.ts` measured it (git 2.50.1, 2026-08-15) and the table is not repeated here: on a
 * repository with no commits `git worktree add` SUCCEEDS and produces an EMPTY tree. An init
 * without a commit would therefore trade an honest "not a git repository" note for agents
 * silently working in an empty directory on a root every probe calls healthy. Loud and correct,
 * replaced by silent and wrong. That is also why `ensureBootRepo` REPAIRS a commitless `.git`
 * rather than reporting it as `existing`.
 *
 * ## Why a new module rather than calling `initGitRepo`
 *
 * `initGitRepo` (`git-init.ts`, the user-facing "Set up git" button) runs `preflightGitInit`
 * itself: it walks the whole tree up to `MAX_SCANNED_FILES` and REFUSES on `truncated` or on any
 * file ≥ `MAX_FILE_BYTES`. The boot root's `.ai/` holds tens of megabytes of run NDJSON, so
 * pointing it here means an expensive walk over content we have already decided to ignore, plus a
 * refusal risk on a path that must never fail at boot. `ensureBootRepo` writes the ignore file
 * FIRST and never scans; it inherits the init-plus-commit rule from `git-init.ts` by citation.
 *
 * ## Never throws
 *
 * A boot-time failure degrades to today's behaviour — the two notes above, in place, one at a
 * time — rather than refusing to start the server. `AGENTS.md`: helpers never throw
 * (except `createWorktree`); degradation is the caller's policy.
 */

/** Present in both files this module authors, and the ONLY thing that lets `holdsOnlyRuntimeState`
 *  tell cezar's own `README.md` from a user's. A marker, not a heuristic: a folder whose single
 *  file is somebody else's README is not a scratch root, and must never be treated as one. */
export const BOOT_REPO_MARKER = 'cezar workspace boot root';

/** Written into `.gitignore`, before `git init`. `.ai/` is cezar's runtime state (run transcripts,
 *  `runs.json`, spools, handoffs, and the task worktrees themselves); `.claude/` is agent config
 *  that may hold credentials. Neither is content, and neither is ever staged. */
export const BOOT_REPO_IGNORED: readonly string[] = ['.ai/', '.claude/'];

/** The only two paths this module ever stages. An explicit add, never `git add -A`: the failure
 *  mode of a careless one here is a first commit holding every run transcript on the box. */
const TRACKED = ['.gitignore', 'README.md'] as const;

/** Entries that are cezar's own state rather than project work. `.git` is included because a
 *  second call must still recognize the root it created. */
const RUNTIME_ENTRIES = new Set<string>(['.ai', '.claude', '.git']);

export interface BootRepoOutcome {
  path: string;
  /** `'existing'` = there was already a usable repository; `'created'` = this call made one (or
   *  repaired a commitless `.git` into one). */
  state: 'existing' | 'created';
  branch: string;
  /** The first commit's sha when `state === 'created'`; the current HEAD otherwise. */
  commit: string;
  /** Written into `.gitignore`. Present only when `state === 'created'`. */
  ignored?: string[];
}

/**
 * Does `root` hold ONLY cezar's runtime state — i.e. is it a scratch boot root rather than a
 * project someone works in?
 *
 * This is the guard that keeps `ensureBootRepo` and the run-time forcing in `workflows/run.ts`
 * off a real repository. `cezar serve` is routinely launched from inside a user's own project,
 * and boot NEVER registers the launch directory (`suppressBootRegistration` returns `true`
 * unconditionally) — so "unregistered" does not distinguish the two, and only the content does.
 * Forcing worktree isolation on, or adopting a twelve-project workspace grant into, a run the
 * user submitted against their own checkout would be a substantially worse defect than the one
 * this spec fixes.
 *
 * An empty directory qualifies. An unreadable one does not: unknown is not scratch.
 */
export async function holdsOnlyRuntimeState(root: string): Promise<boolean> {
  const entries = await readdir(root).catch(() => null);
  if (entries === null) return false;
  for (const name of entries) {
    if (RUNTIME_ENTRIES.has(name)) continue;
    if ((TRACKED as readonly string[]).includes(name)) {
      const text = await readFile(join(root, name), 'utf8').catch(() => '');
      if (text.includes(BOOT_REPO_MARKER)) continue;
    }
    return false;
  }
  return true;
}

/**
 * Make `bootRoot` a git repository with exactly two tracked files, idempotently.
 *
 * Order is the guarantee: `.gitignore` is written BEFORE `git init`, so nothing under `.ai/` or
 * `.claude/` is ever staged, ever in the object database, or ever in a commit somebody would have
 * to rewrite history to remove.
 *
 * The caller decides whether `bootRoot` deserves this — see `holdsOnlyRuntimeState`.
 */
export async function ensureBootRepo(bootRoot: string): Promise<BootRepoOutcome | { error: string }> {
  try {
    const alreadyRepo = await stat(join(bootRoot, '.git')).then(() => true).catch(() => false);
    if (alreadyRepo) {
      const head = await getHeadCommit(bootRoot).catch(() => null);
      // A commitless `.git` — a partial earlier attempt, or a hand-run `git init` — is the exact
      // empty-worktree trap described above. Finish the job instead of reporting it as healthy.
      if (head === null) return await create(bootRoot, { init: false });
      const info = await getRepoInfo(bootRoot).catch(() => null);
      if (info === null) return { error: 'a .git entry exists but git does not read it as a repository' };
      return { path: bootRoot, state: 'existing', branch: info.branch, commit: head };
    }
    return await create(bootRoot, { init: true });
  } catch (err) {
    return { error: firstLine(err instanceof Error ? err.message : String(err)) };
  }
}

async function create(
  bootRoot: string,
  opts: { init: boolean },
): Promise<BootRepoOutcome | { error: string }> {
  await writeBootFiles(bootRoot);
  if (opts.init) await initRepo(bootRoot);
  await git(bootRoot, ['add', '--', ...TRACKED]);
  await commit(bootRoot);

  // Read the result back out of git rather than reporting what we asked for. Answering with a
  // commit that is not there would BE the commitless state this module exists to prevent,
  // reported as success.
  const [commitSha, info] = await Promise.all([
    getHeadCommit(bootRoot).catch(() => null),
    getRepoInfo(bootRoot).catch(() => null),
  ]);
  if (commitSha === null || info === null) {
    return { error: 'git init ran but the repository has no commit — left as is' };
  }
  return {
    path: bootRoot,
    state: 'created',
    branch: info.branch,
    commit: commitSha,
    ignored: [...BOOT_REPO_IGNORED],
  };
}

/** `.gitignore` first, always. Both files carry `BOOT_REPO_MARKER`, which is what
 *  `holdsOnlyRuntimeState` reads on every later boot. */
async function writeBootFiles(bootRoot: string): Promise<void> {
  const gitignore = [
    `# ${BOOT_REPO_MARKER} — cezar's runtime state, never committed.`,
    '# Written before `git init`, so none of it ever reaches the object database.',
    ...BOOT_REPO_IGNORED,
    '',
  ].join('\n');
  const readme = [
    `# ${BOOT_REPO_MARKER}`,
    '',
    "This directory is cezar's boot/scratch manager root. It holds no project work — the work",
    'lives in the registered projects, which a workspace task reaches by absolute path.',
    '',
    "`.ai/` is cezar's runtime state (run transcripts, `runs.json`, spools, handoff files, and the",
    'per-task worktrees) and `.claude/` is agent configuration. Both are gitignored: they are',
    'state, not content.',
    '',
    'The repository exists so a task homed here can be isolated in `.ai/cezar/worktrees/<runId>`',
    'instead of running in the root itself under an exclusive working-tree lease. The first commit',
    'is not optional — `git worktree add` on a commitless repository succeeds and produces an',
    'EMPTY tree.',
    '',
    'Created by cezar (`workspace/boot-repo.ts`); see',
    '`.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`.',
    '',
  ].join('\n');
  await writeFile(join(bootRoot, '.gitignore'), gitignore, 'utf8');
  await writeFile(join(bootRoot, 'README.md'), readme, 'utf8');
}

/** `git init -b main`, with the same fallback `git-init.ts` carries for git older than 2.28. */
async function initRepo(bootRoot: string): Promise<void> {
  try {
    await git(bootRoot, ['init', '-b', 'main']);
  } catch {
    await git(bootRoot, ['init']);
    await git(bootRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  }
}

/**
 * The first commit.
 *
 * The repo-local identity fallback matters more here than anywhere else: the hosted box runs as a
 * service user with no global `user.email`, and a boot that failed on that would leave the root
 * non-git — i.e. exactly where it started. `--no-verify` and `commit.gpgsign=false` for the same
 * class of reason `git-init.ts` uses them: a machine-wide hook path or a passphrase-protected
 * signing key must not hang a server start.
 */
async function commit(bootRoot: string): Promise<void> {
  const configured = await git(bootRoot, ['config', '--get', 'user.email'])
    .then((out) => out.trim() !== '')
    .catch(() => false);
  const identity = configured ? [] : ['-c', 'user.name=cezar', '-c', 'user.email=cezar@localhost'];
  await git(bootRoot, [
    ...identity,
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '--no-verify',
    '-m',
    'chore: cezar boot root',
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
