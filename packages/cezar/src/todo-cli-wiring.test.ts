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

/** Run the CLI outside this repo, so the command resolves without inheriting cezar's own
 *  `.ai/cezar` as an accidental fixture. */
async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-todo-wiring-'));
  dirs.push(cwd);
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', tsxLoader, entry, ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
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
    const { stdout, stderr } = await cli(['todo', 'add', 'Ship it', '--acceptance', 'a', '--json']);
    const output = `${stdout}${stderr}`;
    expect(output).not.toMatch(/unknown option/i);
    expect(output).not.toContain('unknown command: todo');
    expect(JSON.parse(stdout).todo).toMatchObject({ summary: 'Ship it', acceptanceCriteria: ['a'] });
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
