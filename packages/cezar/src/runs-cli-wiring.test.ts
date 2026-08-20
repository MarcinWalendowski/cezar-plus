import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'src/index.ts');
// Absolute, not the bare specifier `tsx`: the child runs in a temp cwd with no `node_modules`,
// where `--import tsx` fails ERR_MODULE_NOT_FOUND before the entry module is ever loaded — a
// failure that looks exactly like the wiring being broken.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/**
 * Is `cez runs reopen` REACHABLE? — not "does `runRunsCommand` work", which `runs/reopen-cli.test.ts`
 * already answers. Same guard and same reasoning as `todo-cli-wiring.test.ts` /
 * `knowledge/cli-wiring.test.ts`: `runKnowledgeCommand` once shipped fully covered and
 * unregistered in `index.ts` for a whole spec cycle, answering `unknown command: kb` on every
 * real install. A brand-new subcommand gets the subprocess-through-the-real-entry-module check
 * from day one rather than after the fact.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Run the CLI outside this repo, with `CEZ_HOME` pinned to a throwaway dir, so neither cezar's
 *  own `.ai/cezar` nor the developer's real registry becomes an accidental fixture. */
async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-runs-wiring-'));
  const home = await mkdtemp(join(tmpdir(), 'cez-runs-wiring-home-'));
  dirs.push(cwd, home);
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', tsxLoader, entry, ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CEZ_HOME: home } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('the runs command is wired into the CLI entry point', () => {
  it('answers `cez runs` with the reopen usage, not with `unknown command`', { timeout: 60_000 }, async () => {
    const { stdout, stderr } = await cli(['runs']);
    const output = `${stdout}${stderr}`;
    expect(output).not.toContain('unknown command: runs');
    expect(output).toContain('cezar runs reopen --all-done');
  });

  it('accepts reopen’s OWN flags, which the strict top-level parser would reject', { timeout: 60_000 }, async () => {
    // `--all-done`, `--dry-run`, `--limit`, `--exclude` are not top-level options. Dispatching
    // `runs` from inside the command switch — the obvious placement, beside every other `case` —
    // puts it AFTER a strict `parseArgs` that throws on the flag first, so the command would be
    // registered and still unusable. This is the guard for that specific wrong fix.
    const { stdout, stderr } = await cli([
      'runs', 'reopen', '--all-done', '--dry-run', '--limit', '1', '--exclude', 'x',
    ]);
    const output = `${stdout}${stderr}`;
    expect(output).not.toMatch(/unknown option/i);
    expect(output).not.toContain('unknown command: runs');
    // The temp cwd has no runs.json at all, so the honest answer is "nothing to do" — and the
    // never-ran-anything project is SKIPPED, not an error.
    expect(output).toContain('no matching runs');
  });

  it('`cez run reopen` is accepted as an alias and never starts a task called "reopen"', { timeout: 60_000 }, async () => {
    const { stdout, stderr } = await cli(['run', 'reopen', '--all-done', '--dry-run']);
    const output = `${stdout}${stderr}`;
    expect(output).not.toMatch(/unknown option/i);
    expect(output).toContain('no matching runs');
  });

  it('still rejects a bogus runs subcommand — reachable, not permissive', { timeout: 60_000 }, async () => {
    const { stdout, stderr, code } = await cli(['runs', 'not-a-subcommand']);
    expect(`${stdout}${stderr}`).toContain('unknown runs subcommand: not-a-subcommand');
    expect(code).toBe(1);
  });

  it('leaves the top-level help advertising it, so it is discoverable without the spec', async () => {
    const { stdout } = await cli(['--help']);
    expect(stdout).toContain('cezar runs reopen');
  });
});
