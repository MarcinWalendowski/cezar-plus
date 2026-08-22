import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

/**
 * Spec 2026-08-22-cross-project-worktree-orphan-prune-safety, Phase 3 prerequisite + Phase 4's
 * "separate assertion for the production wiring itself".
 *
 * `project-context.test.ts`'s AC4 integration test constructs `new ProjectContexts({ listProjects,
 * bootRoot })` directly, so it exercises the boot-root ownership check once wired — but it passes
 * whether or not `startServer` (this file) actually threads `deps.repoRoot` into the
 * `ProjectContexts` it builds for production. Before this spec, it did not: `sharedContexts` was
 * built with no `bootRoot` key at all, so the cross-project ownership check's boot-root candidate
 * was silently empty in every real running process, which is exactly the shape of the 232ad6d4
 * incident (`cezar` IS a registered project, but the run's own record lived at the un-registered
 * boot root). A source-text structural guard, mirroring `workspace/run-index.test.ts`'s C2 guard,
 * is what actually fails if the `bootRoot: deps.repoRoot` line is ever dropped — a unit test that
 * builds its own `ProjectContexts` instance cannot.
 */
describe('startServer wires bootRoot into its ProjectContexts (spec 2026-08-22)', () => {
  it('the sharedContexts construction in startServer names deps.repoRoot as bootRoot', async () => {
    const source = await readFile(new URL('./server.ts', import.meta.url), 'utf8');
    const startServerBody = source.slice(source.indexOf('export function startServer'));
    const sharedContextsMatch = /const sharedContexts = deps\.contexts \?\? new ProjectContexts\(\{[\s\S]*?\n {2}\}\);/.exec(
      startServerBody,
    );
    expect(sharedContextsMatch).not.toBeNull();
    expect(sharedContextsMatch![0]).toMatch(/bootRoot:\s*deps\.repoRoot/);
  });
});
