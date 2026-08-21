import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'src/index.ts');
// Resolved to an ABSOLUTE path from this file, not passed as the bare specifier `tsx`: the child
// runs in a temp cwd with no `node_modules`, where `--import tsx` fails ERR_MODULE_NOT_FOUND
// before the entry module is ever loaded — a failure that looks exactly like the wiring being
// broken.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/**
 * Is `cez todo` REACHABLE? — not "does `runTodoCommand` work", which `todo-cli.test.ts` already
 * answers. Same guard, same reasoning, as `knowledge/cli-wiring.test.ts` — see that file's own
 * doc comment: `runKnowledgeCommand` shipped fully covered and unregistered in `index.ts` for a
 * whole spec cycle, answering `unknown command: kb` on every real install. A subcommand this new
 * (`todo`, `.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`) is exactly the shape of
 * change that regresses the same way, so it gets the same subprocess-through-the-real-entry-
 * module check from day one rather than after the fact.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * Run the CLI outside this repo, so the command resolves without inheriting cezar's own
 * `.ai/cezar` as an accidental fixture.
 *
 * A temp cwd is NOT enough on its own, and `todo add` writes, so the gap files real rows. The
 * entry module resolves the target repo as `getRepoInfo(cwd)?.root ?? cwd` — a walk UP for a git
 * toplevel — while `os.tmpdir()` honours `$TMPDIR`, which a cezar run points INSIDE the repo
 * under test (`.ai/cezar/tmp/<runId>`). The walk then leaves the temp dir, finds cezar's own
 * root, and every `npm test` files another "Ship it" onto the live board: 10 of them reached
 * production between 2026-08-19 and 2026-08-21. `git init` stops the walk here whatever
 * `$TMPDIR` says — the todo lands in `cwd`, which `afterEach` removes.
 */
async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number; cwd: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-todo-wiring-'));
  dirs.push(cwd);
  await execFile('git', ['init', '-q'], { cwd });
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', tsxLoader, entry, ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env } },
    );
    return { stdout, stderr, code: 0, cwd };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1, cwd };
  }
}

describe('the todo command is wired into the CLI entry point', () => {
  it('answers `cez todo` with the todo usage, not with `unknown command`', { timeout: 60_000 }, async () => {
    const { stdout, stderr } = await cli(['todo']);
    const output = `${stdout}${stderr}`;
    expect(output).not.toContain('unknown command: todo');
    expect(output).toContain('cezar todo add');
    expect(output).toContain('cezar todo list');
  });

  it('accepts todo add’s OWN flags, which the strict top-level parser would reject', { timeout: 60_000 }, async () => {
    // `--acceptance` (repeatable) and `--json` are not top-level options. Dispatching `todo` from
    // inside the command switch — the obvious placement, beside every other `case` — puts it
    // AFTER a strict `parseArgs` that throws on the flag first, so the command is registered and
    // still unusable. This is the guard for that specific wrong fix; `todo` is routed before the
    // parser, as `kb`/`backup` are.
    const { stdout, stderr, cwd } = await cli(['todo', 'add', 'Ship it', '--acceptance', 'a', '--json']);
    const output = `${stdout}${stderr}`;
    expect(output).not.toMatch(/unknown option/i);
    expect(output).not.toContain('unknown command: todo');
    expect(JSON.parse(stdout).todo).toMatchObject({ summary: 'Ship it', acceptanceCriteria: ['a'] });

    // The isolation is the other half of this case, not a side effect of it: `todo add` WRITES,
    // and the assertions above pass just as happily when the row landed on the real board. Pin
    // the write to the temp root, so a regression in where `cwd` resolves fails here instead of
    // showing up as junk rows in production.
    const filed = JSON.parse(await readFile(join(cwd, '.ai/cezar/todos.json'), 'utf8'));
    expect(filed).toHaveLength(1);
    expect(filed[0]).toMatchObject({ summary: 'Ship it' });
  });

  it('does not file into THIS repo when $TMPDIR points inside it — the production leak', { timeout: 60_000 }, async () => {
    // The bug this pins, in the environment that had it: every cezar agent run sets
    // `TMPDIR=<repo>/.ai/cezar/tmp/<runId>`, so `os.tmpdir()` hands the "isolated" cwd back
    // INSIDE the repo under test, the entry module's walk up for a git toplevel leaves it, and
    // `todo add` files a real row onto the live board — 10 "Ship it" rows reached production
    // between 2026-08-19 and 2026-08-21. CI never reproduced it because `$TMPDIR` is `/tmp`
    // there, which is why a fully-covered, CI-green test leaked for two days. Set the same
    // TMPDIR here so CI fails on a regression instead of production absorbing it.
    const repoRoot = resolve(packageRoot, '../..');
    const board = join(repoRoot, '.ai/cezar/todos.json');
    const before = await readFile(board, 'utf8').catch(() => null);

    const base = join(repoRoot, '.ai/cezar/tmp');
    await mkdir(base, { recursive: true });
    const insideRepo = await mkdtemp(join(base, 'cez-todo-wiring-tmpdir-'));
    dirs.push(insideRepo);
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = insideRepo;
    try {
      const { stdout, cwd } = await cli(['todo', 'add', 'Ship it', '--acceptance', 'a', '--json']);
      expect(JSON.parse(stdout).todo).toMatchObject({ summary: 'Ship it' });
      expect(cwd.startsWith(insideRepo)).toBe(true); // the condition really was reproduced
      const filed = JSON.parse(await readFile(join(cwd, '.ai/cezar/todos.json'), 'utf8'));
      expect(filed).toHaveLength(1);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }

    // The whole point: this repo's own board is exactly as it was — still absent on a fresh
    // checkout (CI), still byte-identical on a dev machine that has one.
    expect(await readFile(board, 'utf8').catch(() => null)).toBe(before);
  });

  it('still rejects a bogus todo subcommand — reachable, not permissive', { timeout: 60_000 }, async () => {
    const { stdout, stderr, code } = await cli(['todo', 'not-a-subcommand']);
    expect(`${stdout}${stderr}`).toContain('unknown todo subcommand: not-a-subcommand');
    expect(code).toBe(1);
  });

  it('leaves the top-level help advertising it, so it is discoverable without the spec', async () => {
    const { stdout } = await cli(['--help']);
    expect(stdout).toContain('cezar todo');
  });
});
