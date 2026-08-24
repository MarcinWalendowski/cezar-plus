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
// failure that looks exactly like the wiring being broken. Same pattern as `runs-cli-wiring.test.ts`.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/**
 * Is `cezar server-deploy --dry-run` REACHABLE? — `release-deploy.test.ts` and `release-cli.test.ts`
 * already answer "does the logic work"; this is the only place that proves the `parseArgs`
 * registration itself is correct, since a unit test on `releaseDeployCommand` never touches
 * `parseArgs` at all. Measured 2026-08-21 (`.ai/specs/2026-08-22-server-deploy-dry-run-flag.md`):
 * before this spec, `--dry-run` was an unregistered option and `parseArgs` rejected it outright.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Run the CLI outside this repo, with `CEZ_HOME` pinned to a throwaway dir, so neither cezar's
 *  own `.ai/cezar` nor the developer's real registry becomes an accidental fixture. */
async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-deploy-wiring-'));
  const home = await mkdtemp(join(tmpdir(), 'cez-deploy-wiring-home-'));
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

describe('`server-deploy --dry-run` is wired into the CLI entry point', () => {
  it(
    'does not answer `Unknown option` and exits 0',
    { timeout: 60_000 },
    async () => {
      const { stdout, stderr, code } = await cli(['server-deploy', '--strategy=blue-green', '--dry-run']);
      const output = `${stdout}${stderr}`;
      expect(output).not.toMatch(/unknown option/i);
      expect(code).toBe(0);
    },
  );

  it('leaves the top-level help advertising it, scoped to the `server-deploy` block', async () => {
    const { stdout } = await cli(['--help']);
    // A bare `expect(stdout).toContain('--dry-run')` would pass against unmodified code — `HELP`
    // already has `[--dry-run]` under `cezar runs reopen`. Slice between the `server-deploy` line
    // and the next command block instead, so this fails until the help text is actually edited.
    const start = stdout.indexOf('cezar server-deploy');
    const end = stdout.indexOf('cezar server-migrate-releases');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = stdout.slice(start, end);
    expect(block).toContain('--dry-run');
  });
});

/**
 * Is bare `cezar server-deploy --rollback` (no `=value`) REACHABLE? — `.ai/specs/
 * 2026-08-23-bare-rollback-argv-trap.md`. node's `parseArgs` has no optional-value option type, so
 * `rollback: { type: 'string' }` made the bare flag throw `argument missing` (end of argv) or
 * `argument is ambiguous` (followed by another flag) before `case 'server-deploy'` was ever
 * reached — the exact shape an operator types under pressure during a rollback. All cases run with
 * `--dry-run` so none can flip a symlink or restart a unit.
 */
describe('bare `--rollback` (no value) is wired into the CLI entry point', () => {
  it(
    'accepts --rollback followed by another flag (the "ambiguous" shape)',
    { timeout: 60_000 },
    async () => {
      const { stdout, stderr, code } = await cli(['server-deploy', '--rollback', '--dry-run']);
      const output = `${stdout}${stderr}`;
      expect(output).not.toMatch(/argument missing|ambiguous|unknown option/i);
      expect(code).toBe(0);
    },
  );

  it(
    'accepts --rollback at the end of argv (the "argument missing" shape)',
    { timeout: 60_000 },
    async () => {
      const { stdout, stderr, code } = await cli(['server-deploy', '--dry-run', '--rollback']);
      const output = `${stdout}${stderr}`;
      expect(output).not.toMatch(/argument missing|ambiguous|unknown option/i);
      expect(code).toBe(0);
    },
  );

  it(
    'control: --rollback= (already-working explicit-empty form) keeps working',
    { timeout: 60_000 },
    async () => {
      const { stdout, stderr, code } = await cli(['server-deploy', '--rollback=', '--dry-run']);
      const output = `${stdout}${stderr}`;
      expect(output).not.toMatch(/argument missing|ambiguous|unknown option/i);
      expect(code).toBe(0);
    },
  );

  it(
    '--rollback r1 (space separated) still names r1, not the previous release',
    { timeout: 60_000 },
    async () => {
      const { stdout, stderr, code } = await cli(['server-deploy', '--rollback', 'r1', '--dry-run']);
      const output = `${stdout}${stderr}`;
      expect(output).not.toMatch(/argument missing|ambiguous|unknown option/i);
      expect(code).toBe(0);
      expect(output).toContain('r1');
      expect(output).not.toContain('the previous release');
    },
  );
});
