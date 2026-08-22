import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BOOT_REPO_MARKER, ensureBootRepo, holdsOnlyRuntimeState } from './boot-repo.ts';

/**
 * V1/V2 of `.ai/specs/2026-08-21-workspace-boot-repo-and-always-worktrees.md`.
 *
 * Two of these are the risk register, asserted rather than trusted:
 *
 *  - R1 (47 MB of run transcripts in the first commit) and R2 (`.claude/` credentials, a `.env`)
 *    are both "`ls-files` prints exactly two paths", against a fixture that genuinely contains a
 *    megabyte of NDJSON and a secret.
 *  - V2 is the measured claim the whole design rests on — `git worktree add` on a COMMITLESS repo
 *    produces an empty tree. `git-init.ts` records it in a table; here it is a test, because if it
 *    ever stopped being true the honest thing would be to delete the commit, and if it silently
 *    started being false again every boot-root task would run in an empty directory.
 */

const dirs: string[] = [];

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-boot-repo-'));
  dirs.push(dir);
  return dir;
}

/** The boot root as it actually looks on the box: runtime state, agent config, and a secret. */
function scratchRoot(): string {
  const dir = fixture();
  mkdirSync(join(dir, '.ai/cezar/runs'), { recursive: true });
  writeFileSync(join(dir, '.ai/cezar/runs/big.ndjson'), 'x'.repeat(1024 * 1024 + 1));
  writeFileSync(join(dir, '.ai/cezar/runs.json'), '{"runs":[]}');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude/settings.json'), '{"token":"secret"}');
  writeFileSync(join(dir, '.env'), 'API_KEY=secret\n');
  return dir;
}

const gitOut = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const tracked = (cwd: string): string[] =>
  gitOut(cwd, ['ls-files']).split('\n').filter(Boolean).sort();

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ensureBootRepo', () => {
  it('creates a repository that tracks the two authored files and nothing else (R1, R2)', async () => {
    const dir = scratchRoot();

    const outcome = await ensureBootRepo(dir);

    expect(outcome).not.toHaveProperty('error');
    if ('error' in outcome) throw new Error(outcome.error);
    expect(outcome.state).toBe('created');
    expect(outcome.branch).toBe('main');
    expect(outcome.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(outcome.ignored).toEqual(['.ai/', '.claude/']);

    // The whole risk register in one assertion: not the transcripts, not runs.json, not
    // `.claude/settings.json`, not the `.env`.
    expect(tracked(dir)).toEqual(['.gitignore', 'README.md']);
    expect(gitOut(dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  });

  it('is idempotent — a second call reports the repository it found and adds no commit', async () => {
    const dir = scratchRoot();
    const first = await ensureBootRepo(dir);
    if ('error' in first) throw new Error(first.error);

    const second = await ensureBootRepo(dir);

    if ('error' in second) throw new Error(second.error);
    expect(second.state).toBe('existing');
    expect(second.commit).toBe(first.commit);
    expect(second.ignored).toBeUndefined();
    expect(gitOut(dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  });

  it('commits on a host with no global git identity', async () => {
    const dir = scratchRoot();
    const home = fixture();
    const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    // `GIT_CONFIG_GLOBAL=/dev/null` is the only spelling that reliably hides a global identity
    // from git regardless of how the running host is configured; HOME alone is not enough when
    // XDG_CONFIG_HOME is set.
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, 'xdg');
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      const outcome = await ensureBootRepo(dir);
      if ('error' in outcome) throw new Error(outcome.error);
      expect(outcome.state).toBe('created');
      expect(gitOut(dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    } finally {
      process.env.HOME = previous.HOME;
      if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME;
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
  });

  it('repairs a commitless .git rather than reporting it healthy', async () => {
    const dir = scratchRoot();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });

    const outcome = await ensureBootRepo(dir);

    if ('error' in outcome) throw new Error(outcome.error);
    expect(outcome.state).toBe('created');
    expect(gitOut(dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(tracked(dir)).toEqual(['.gitignore', 'README.md']);
  });

  it('V2 — a worktree of the created repo actually contains the files (the empty-tree trap)', async () => {
    const dir = scratchRoot();
    const outcome = await ensureBootRepo(dir);
    if ('error' in outcome) throw new Error(outcome.error);

    // The bare form `git-init.ts`'s table measured — no commit-ish, so git decides for itself
    // what the new tree gets. On a commitless repo it infers `--orphan` and hands back nothing.
    const worktree = join(dir, '.ai/cezar/worktrees/t');
    execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: dir });

    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
    expect(existsSync(join(worktree, '.gitignore'))).toBe(true);
  });

  it('V2 control — the same worktree of a COMMITLESS repo is empty', () => {
    const dir = fixture();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# not committed\n');

    const worktree = join(dir, 'wt');
    execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: dir });

    // The measured claim from `git-init.ts`'s table: the add succeeds, and the tree is empty.
    expect(existsSync(join(worktree, 'README.md'))).toBe(false);
  });
});

describe('holdsOnlyRuntimeState', () => {
  it('accepts an empty directory and one holding only cezar runtime state', async () => {
    expect(await holdsOnlyRuntimeState(fixture())).toBe(true);
    expect(await holdsOnlyRuntimeState(scratchRoot())).toBe(false); // the `.env` is project content
  });

  it("stays true across ensureBootRepo's own two files", async () => {
    const dir = fixture();
    mkdirSync(join(dir, '.ai/cezar'), { recursive: true });
    expect(await holdsOnlyRuntimeState(dir)).toBe(true);

    const outcome = await ensureBootRepo(dir);
    if ('error' in outcome) throw new Error(outcome.error);

    // The second boot must still recognize the root it created — otherwise the forcing in
    // `workflows/run.ts` would apply on exactly one boot and never again.
    expect(await holdsOnlyRuntimeState(dir)).toBe(true);
  });

  it('refuses a real project — including one whose only file is somebody else\'s README', async () => {
    const project = fixture();
    writeFileSync(join(project, 'README.md'), '# my app\n');
    expect(await holdsOnlyRuntimeState(project)).toBe(false);
    expect(BOOT_REPO_MARKER).not.toBe('');

    const withSource = fixture();
    mkdirSync(join(withSource, 'src'), { recursive: true });
    writeFileSync(join(withSource, 'src/index.ts'), 'export {};\n');
    expect(await holdsOnlyRuntimeState(withSource)).toBe(false);
  });

  it('refuses an unreadable directory — unknown is not scratch', async () => {
    expect(await holdsOnlyRuntimeState(join(fixture(), 'does-not-exist'))).toBe(false);
  });
});
