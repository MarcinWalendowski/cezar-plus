import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../..');
const entry = join(packageRoot, 'src/index.ts');
const FIXTURE = join(packageRoot, 'src/core/__fixtures__/runs/ec6e8e06-trimmed.ndjson');
const RUN_ID = 'ec6e8e06-16e4-448f-a7b9-b00411fcc3d0';
// Absolute, not the bare specifier `tsx`: the child runs in a temp cwd with no `node_modules`,
// where `--import tsx` fails ERR_MODULE_NOT_FOUND before the entry module ever loads — a failure
// that looks exactly like the wiring being broken. Same reasoning as `knowledge/cli-wiring.test.ts`.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/**
 * Is `cez run stats` REACHABLE? — not "does `runRunStatsCommand` work", which `runs/stats.test.ts`
 * already answers.
 *
 * The distinction earned its own file here for a reason specific to THIS command, on top of the
 * one `knowledge/cli-wiring.test.ts` sets out at length. `cez run "<task>"` joins every positional
 * into the task text, so a `run stats <id>` that misses its dispatch does not fail loudly with
 * `unknown command` — **it starts a real agent run titled "stats <id>"**, in whatever repo the
 * user happened to be standing in. The wrong outcome is expensive and silent, and no in-process
 * import of `runRunStatsCommand` could ever detect it. Hence a subprocess through the real entry
 * module, the same way every `npm run` script in this package invokes it.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFile(process.execPath, ['--import', tsxLoader, entry, ...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

/** A scratch repo whose `.ai/cezar/runs/<id>.ndjson` is the real recording. */
async function repoWithRun(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cez-stats-wiring-'));
  dirs.push(root);
  await mkdir(join(root, '.ai/cezar/runs'), { recursive: true });
  await copyFile(FIXTURE, join(root, '.ai/cezar/runs', `${RUN_ID}.ndjson`));
  return root;
}

describe('the `run stats` command is wired into the CLI entry point', () => {
  it('meters the run instead of STARTING one named "stats <id>"', { timeout: 60_000 }, async () => {
    const cwd = await repoWithRun();
    const { stdout, stderr, code } = await cli(['run', 'stats', RUN_ID], cwd);
    const output = `${stdout}${stderr}`;
    expect(code).toBe(0);
    expect(output).toContain('batch factor 1.00');
    expect(output).toContain('TOTAL');
    // The failure this file exists for: `case 'run'` swallowing the positionals and spawning an
    // agent. A started run writes `runs.json`; a metered one does not.
    expect(output).not.toMatch(/starting|workflow/i);
  });

  it('accepts --json, which the strict top-level parser would reject', { timeout: 60_000 }, async () => {
    const cwd = await repoWithRun();
    const { stdout, stderr, code } = await cli(['run', 'stats', RUN_ID, '--json'], cwd);
    expect(`${stdout}${stderr}`).not.toMatch(/unknown option/i);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ runId: RUN_ID, totals: { toolCalls: 271, batchFactor: 1 } });
  });

  it('still fails loudly on an unknown run — reachable, not permissive', { timeout: 60_000 }, async () => {
    // The negative control: a dispatch that swallowed everything under `run stats` and always
    // printed something would satisfy both cases above.
    const cwd = await repoWithRun();
    const { stdout, stderr, code } = await cli(['run', 'stats', 'no-such-run'], cwd);
    expect(`${stdout}${stderr}`).toContain('no transcript');
    expect(code).toBe(1);
  });

  it('leaves `cezar run "<task>"` doing what it always did', { timeout: 60_000 }, async () => {
    // Only the exact two-token prefix `run stats` is intercepted. Asserted through `--help`
    // rather than by starting a real agent run.
    const cwd = await repoWithRun();
    const { stdout } = await cli(['--help'], cwd);
    expect(stdout).toContain('cezar run "<task>"');
    expect(stdout).toContain('cezar run stats <runId>');
  });
});
