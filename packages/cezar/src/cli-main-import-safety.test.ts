import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `index.ts` is this package's CLI entry point — `bin: cezar`/`cez`/`cezar-cli` (package.json)
 * all three resolve to this same built `dist/index.js` — and it used to run `main()`
 * unconditionally at module load (`main().catch(...)`, no guard). That meant merely IMPORTING
 * this module — the only way to reach anything module-scoped inside it, since it exports nothing
 * — executed the real CLI dispatch against whatever `process.argv` the importer happened to
 * carry. `kb-submit-signing.test.ts` documents this as the reason it drives `cez kb submit` via a
 * subprocess instead of an import.
 *
 * The guard in `index.ts` requires BOTH `process.env.VITEST` (this repo's own existing "is this a
 * test process" signal) AND `process.env.CEZAR_TEST_SKIP_MAIN === '1'` before it will skip
 * `main()` — see that file's own comment for why it is two conditions, and why the flag is
 * deliberately not `CEZ_*`-prefixed (that prefix auto-forwards to every spawned agent child via
 * `core/agent-env.ts#buildChildEnv`; this flag must not). This file is the first thing in the
 * repo that imports `index.ts` at all — nothing could, safely, before this guard existed.
 *
 * The proofs below are behavioural, not structural: point `process.argv` at `--help`, which
 * `main()` answers with a synchronous `console.log(HELP); return;` before its first `await` (no
 * repo detection, no I/O) — so if `main()` ran, the banner has already printed by the time the
 * dynamic `import()` call resolves.
 */
describe('index.ts module-load safety', () => {
  const originalArgv = process.argv;
  const originalVitestFlag = process.env.VITEST;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitCodeBefore: number | string | undefined;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitCodeBefore = process.exitCode;
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.argv = originalArgv;
    process.exitCode = exitCodeBefore;
    delete process.env.CEZAR_TEST_SKIP_MAIN;
    if (originalVitestFlag === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitestFlag;
  });

  /**
   * Non-vacuous, checked by hand: reverting the guard in `index.ts` back to a bare
   * `main().catch(...)` and re-running just this file fails this `it` — the import then runs
   * `main()` unconditionally against this same `--help` argv regardless of either env var, and
   * the banner prints.
   */
  it('VITEST + CEZAR_TEST_SKIP_MAIN=1: importing does not run main() — the --help banner never prints', async () => {
    process.argv = [...originalArgv.slice(0, 2), '--help'];
    process.env.VITEST = 'true';
    process.env.CEZAR_TEST_SKIP_MAIN = '1';
    vi.resetModules();

    await import('./index.ts');

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('suppression is not silent: it names the variable on stderr and leaves process.exitCode alone', async () => {
    process.argv = [...originalArgv.slice(0, 2), '--help'];
    process.env.VITEST = 'true';
    process.env.CEZAR_TEST_SKIP_MAIN = '1';
    vi.resetModules();

    await import('./index.ts');

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).toContain('CEZAR_TEST_SKIP_MAIN');
    expect(message).toContain('main() skipped');
    // The legitimate use of this escape hatch is a side-effect-free import for a test — forcing a
    // failing exit code here would make every honest test that imports this module look like the
    // whole worker failed. It must come back exactly as it went in.
    expect(process.exitCode).toBe(exitCodeBefore);
  });

  /**
   * The hazard `index.ts`'s guard comment documents: `CEZ_*` vars are forwarded wholesale to every
   * spawned agent child by `core/agent-env.ts#buildChildEnv`, so a `CEZ_*`-prefixed skip flag
   * would silently disable real invocations anywhere downstream of a process that happened to
   * inherit it. `CEZAR_TEST_SKIP_MAIN` alone — without `VITEST` also being true, which no real
   * install of this binary ever is — must NOT be enough to suppress `main()`. This is what makes
   * that true, not just documented.
   */
  it('CEZAR_TEST_SKIP_MAIN alone, without VITEST, does not suppress main() — the flag needs both gates', async () => {
    process.argv = [...originalArgv.slice(0, 2), '--help'];
    // Falsy, not deleted — every existing check of this var in the repo (`paths.ts`,
    // `server/open-in-terminal.ts`) is a truthiness check, never an `in` check, so this is the
    // narrowest way to make the guard read "VITEST is off" without removing the key entirely
    // from a real vitest worker's own environment.
    process.env.VITEST = '';
    process.env.CEZAR_TEST_SKIP_MAIN = '1';
    vi.resetModules();

    await import('./index.ts');

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('cezar — local cockpit'));
  });

  it('no skip vars set: import safely reaches main()\'s own dispatch — kb submit --help', async () => {
    process.argv = [...originalArgv.slice(0, 2), 'kb', 'submit', '--help'];
    delete process.env.CEZAR_TEST_SKIP_MAIN;
    vi.resetModules();

    await import('./index.ts');

    expect(logSpy).toHaveBeenCalledWith('usage: cez kb submit <corpus-path> [--content "..."] [--note "..."] [--json]');
  });
});
