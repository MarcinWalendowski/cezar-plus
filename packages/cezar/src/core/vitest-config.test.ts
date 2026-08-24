import { describe, expect, it } from 'vitest';

import { halfParallelism } from './search-parallelism.ts';

/**
 * Package 0.5: proves the wiring in `vitest.config.ts` itself, not just the extracted
 * `search-parallelism.ts` helpers it calls. `defineConfig` (vitest's own `dist/config.js`) is
 * `(config) => config` at runtime, so importing the real config module here is safe — no
 * second vitest instance is started, this only re-evaluates the same plain object literal.
 *
 * `CEZ_VITEST_MAX_WORKERS` is guaranteed unset by the time this file's imports run:
 * `vitest.setup.ts` scrubs every `CEZ_*` var (except the two run-identity ones) before any test
 * file loads, and that scrub runs before this file's own top-level `import` of `vitest.config.ts`
 * evaluates it — so this asserts the DEFAULT derivation is actually wired into `test.maxWorkers`,
 * not merely defined and unused. The override branch itself is `positiveIntEnvOr`'s own
 * responsibility and is fully covered in `search-parallelism.test.ts`.
 */
describe('vitest.config.ts — maxWorkers wiring', () => {
  it('wires the default half-parallelism derivation into test.maxWorkers', async () => {
    const config = (await import('../../vitest.config.ts')).default;
    expect(config.test?.maxWorkers).toBe(halfParallelism());
  });

  it('is a positive integer, never 0 or fractional', () => {
    // Re-assert the invariant `positiveIntEnvOr`/`halfParallelism` are supposed to guarantee,
    // at the point this config value is actually consumed by vitest.
    expect(Number.isInteger(halfParallelism())).toBe(true);
    expect(halfParallelism()).toBeGreaterThanOrEqual(1);
  });
});

/**
 * **Added 2026-08-23 after the two cases above passed through a completely broken gate.**
 *
 * `maxWorkers` was set on this project alone. Vitest 4 requires projects that differ in
 * `maxWorkers` to carry distinct `sequence.groupOrder`, so the whole-repo `vitest run` died in
 * PLANNING with zero test files executed — for hours, while roughly twenty agents ran narrow
 * per-project commands and every one of them truthfully reported green.
 *
 * Neither case above could have seen it, and no amount of strengthening them would: they assert a
 * property of ONE project's config, and the broken thing is a relationship BETWEEN projects. A
 * cross-project constraint needs a cross-project assertion, which means reading the root config's
 * own project list rather than this package's config.
 *
 * The uniformity is also not merely the validator's demand — it is what makes the cap real.
 * Projects that agree share one worker pool, so half the box is budgeted to the gate as a whole.
 * Capping `server` while `web` still forks a worker per test file bounds nothing, which is why
 * this asserts agreement rather than asserting "every project has the field".
 */
/** The repo root, as a URL — `src/core/` is four levels down from it. */
const REPO_ROOT = new URL('../../../../', import.meta.url);

/**
 * Loads a config that lives OUTSIDE this package.
 *
 * The specifier is built at runtime and passed through `@vite-ignore` on purpose, and both halves
 * of that are load-bearing. A static relative import would be checked by `tsc`, which rejects it —
 * `rootDir` is `packages/cezar`, so naming `../../../../packages/web/vitest.config.ts` fails with
 * TS6059 and additionally drags web's config into this package's program, where its own
 * `./vite.config` import cannot resolve. A non-literal specifier is invisible to that check while
 * still resolving correctly at runtime through vitest's module runner. The URL form matters too:
 * a bare relative string loses its base here and resolves against the filesystem root.
 */
async function loadConfig(repoRelativePath: string): Promise<{ test?: { maxWorkers?: number } }> {
  const href = new URL(repoRelativePath.replace(/^\.\//, ''), REPO_ROOT).href;
  const mod = (await import(/* @vite-ignore */ href)) as { default: { test?: { maxWorkers?: number } } };
  return mod.default;
}

describe('the root config — every project must agree on maxWorkers', () => {
  it('all projects resolve to the SAME maxWorkers, so they share one pool', async () => {
    const root = await loadConfig('vitest.config.ts');
    const projectPaths = (root.test as { projects?: string[] } | undefined)?.projects;

    // Floor first. Every assertion below iterates this list, so an empty or missing one would make
    // the whole case vacuously true — the failure mode a guard like this dies of.
    expect(Array.isArray(projectPaths)).toBe(true);
    expect(projectPaths!.length).toBeGreaterThanOrEqual(3);

    const resolved = await Promise.all(
      projectPaths!.map(async (rel) => ({ rel, maxWorkers: (await loadConfig(rel)).test?.maxWorkers })),
    );

    for (const { rel, maxWorkers } of resolved) {
      expect(maxWorkers, `${rel} has no maxWorkers — the cap is only real if it is uniform`).toBe(
        halfParallelism(),
      );
    }
    // Asserted as a set as well, so a future per-project override cannot satisfy the loop above
    // while still splitting the pool in two.
    expect(new Set(resolved.map((r) => r.maxWorkers)).size).toBe(1);

    // Driven off the root config's OWN list rather than a hardcoded three, so a fourth project
    // added to the gate is checked automatically instead of escaping this guard silently — which
    // is the exact shape of hole that let the original break through.
    expect(resolved.length).toBe(projectPaths!.length);
  });
});
