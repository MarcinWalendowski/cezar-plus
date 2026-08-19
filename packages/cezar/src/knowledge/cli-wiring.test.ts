import { execFile as execFileCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entry = join(packageRoot, 'src/index.ts');
// Resolved to an ABSOLUTE path from this file, not passed as the bare specifier `tsx`: the child
// runs in a temp cwd with no `node_modules`, where `--import tsx` fails ERR_MODULE_NOT_FOUND
// before the entry module is ever loaded — a failure that looks exactly like the wiring being
// broken.
const tsxLoader = createRequire(import.meta.url).resolve('tsx');

/**
 * Is `cez kb` REACHABLE? — not "does `runKnowledgeCommand` work", which
 * `knowledge/cli.test.ts` has answered yes to since the day it was written.
 *
 * That distinction is the entire point of this file, and it is not academic. Until
 * `.ai/specs/2026-08-19-tasks-page-and-start-grounding.md` (D4), `runKnowledgeCommand` was
 * imported by nothing but its own test: fully implemented, fully covered, and unregistered in
 * `index.ts`. So `cez kb search "<query>"` — the exact command `knowledgeSystemPrompt` puts in
 * front of EVERY agent run, on every install with `CEZ_KB=1` — answered `unknown command: kb` and
 * printed the top-level help. It was found by reading a production run's event stream, not by the
 * suite, because a unit test over a function proves the function and says nothing at all about
 * whether an entry point calls it.
 *
 * Hence a SUBPROCESS through the real entry module (`src/index.ts` under tsx, the same way every
 * `npm run` script in this package invokes it). Nothing importable can stand in: the wiring under
 * test IS the entry module's dispatch, and an in-process import of `runKnowledgeCommand` would be
 * green again the moment someone deletes the dispatch — which is precisely the state this file
 * exists to make impossible.
 *
 * Kept deliberately cheap: `--help` and one bad subcommand, no store, no scan, no `CEZ_KB=1`.
 * Behaviour lives in `cli.test.ts`; reachability lives here.
 */

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Run the CLI outside this repo, so the command resolves without inheriting cezar's own
 *  `.ai/cezar` as an accidental fixture. `CEZ_KB` is left unset on purpose — the flag-off path is
 *  still a REACHED command, and reaching it is what is under test. */
async function cli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const cwd = await mkdtemp(join(tmpdir(), 'cez-kb-wiring-'));
  dirs.push(cwd);
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      ['--import', tsxLoader, entry, ...args],
      { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, CEZ_KB: undefined } },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

describe('the kb command is wired into the CLI entry point', () => {
  it('answers `cez kb` with the kb usage, not with `unknown command`', { timeout: 60_000 }, async () => {
    const { stdout, stderr } = await cli(['kb']);
    const output = `${stdout}${stderr}`;
    // The exact string production printed while this was unwired. Asserted verbatim, because a
    // looser check ("output is non-empty", "exit code is 0") passed throughout that entire period.
    expect(output).not.toContain('unknown command: kb');
    expect(output).toContain('cez kb search');
    expect(output).toContain('cez kb show');
  });

  it('accepts kb’s OWN flags, which the strict top-level parser would reject', { timeout: 60_000 }, async () => {
    // `--json` is not a top-level option. Dispatching `kb` from inside the command switch — the
    // obvious placement, beside every other `case` — puts it AFTER a strict `parseArgs` that
    // throws on the flag first, so the command is registered and still unusable. This is the guard
    // for that specific wrong fix; `kb` is routed before the parser, as `backup` is.
    const { stdout, stderr } = await cli(['kb', 'search', 'anything', '--json']);
    const output = `${stdout}${stderr}`;
    expect(output).not.toMatch(/unknown option/i);
    expect(output).not.toContain('unknown command: kb');
    // With CEZ_KB unset this is the documented flag-off shape — a real answer from the real
    // command, which is exactly what "reachable" means here.
    expect(JSON.parse(stdout)).toMatchObject({ available: false });
  });

  it('still rejects a bogus kb subcommand — reachable, not permissive', { timeout: 60_000 }, async () => {
    // The negative control. Without it, a dispatch that swallowed everything under `kb` and always
    // printed usage would satisfy both cases above.
    const { stdout, stderr, code } = await cli(['kb', 'not-a-subcommand']);
    expect(`${stdout}${stderr}`).toContain('unknown kb subcommand: not-a-subcommand');
    expect(code).toBe(1);
  });

  it('leaves the top-level help advertising it, so it is discoverable without the spec', async () => {
    const { stdout } = await cli(['--help']);
    expect(stdout).toContain('cezar kb');
  });

  it('advertises only subcommands that exist — the help cannot drift from the dispatch', async () => {
    // The first version of this help block listed `list`, which `runKnowledgeCommand` has never
    // had: production answered `unknown kb subcommand: list` to the only discovery surface a
    // reader has. Caught by hand on the box, not by the suite — so the two sources are compared
    // here instead of both being written down twice and trusted to stay equal.
    const usage = await cli(['kb']);
    const real = new Set(
      [...`${usage.stdout}${usage.stderr}`.matchAll(/cez kb ([a-z]+)/g)].map((m) => m[1]),
    );
    expect(real.size).toBeGreaterThan(3); // floor: a parse that found nothing must not pass

    const { stdout: help } = await cli(['--help']);
    const block = help.slice(help.indexOf('cezar kb'));
    const advertised = [...block.slice(0, block.indexOf('cezar backup')).matchAll(/·\s*([a-z]+)/g)]
      .map((m) => m[1])
      .filter((word) => word !== 'json');
    expect(advertised.length).toBeGreaterThan(2); // floor: an empty list agrees with anything
    for (const word of advertised) expect([...real]).toContain(word);
  });
});
