import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_IMPLEMENTATION_WORKFLOW } from './types.ts';

/**
 * `AUTONOMOUS_IMPLEMENTATION_WORKFLOW` (PLAN D27 Phase 2, `.ai/specs/2026-08-15-autonomous-
 * implementation-continuation.md`): the workflow an autonomous note's spec run continues into,
 * unattended. It gets a real shell — unlike `note-to-spec` — to run whatever gates a registered
 * project defines, so this workflow's own guarantee ("no git remote is reachable") is enforced
 * structurally here, not left to the prompt: no `git push` (or bare `git`), and no bare
 * `npm run`/`pnpm run`/`yarn run`/`make` prefix broad enough to invoke a target repo's OWN
 * `deploy`/`release`/`publish` script. See the workflow's own doc comment for the one named
 * exception this file does NOT check (installs reach a registry by design).
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | No `bashAllowlist` entry can match a `git push` command | add `'git push'` (or a bare `'git'`) to the allowlist |
 * | Bash is never granted UNRESTRICTED (bashAllowlist non-empty) | delete the `bashAllowlist` array |
 * | No script/task-runner entry is a bare, subcommand-less prefix | add bare `'npm run'` or `'make'` back |
 */

function bashAllowlist(): string[] {
  const step = AUTONOMOUS_IMPLEMENTATION_WORKFLOW.steps[0];
  return step?.bashAllowlist ?? [];
}

describe('AUTONOMOUS_IMPLEMENTATION_WORKFLOW cannot push', () => {
  it('grants Bash only through a non-empty bashAllowlist, never unrestricted', () => {
    const step = AUTONOMOUS_IMPLEMENTATION_WORKFLOW.steps[0];
    expect(step?.allowedTools).toContain('Bash');
    // `claude-cli-runner.ts`'s `buildAllowedTools()`: `Bash` with no `bashAllowlist` (or an empty
    // one) becomes plain, UNRESTRICTED `Bash` — the zero-config default. A push-free allowlist
    // means nothing if this is ever empty.
    expect(bashAllowlist().length).toBeGreaterThan(0);
  });

  it('has no bashAllowlist entry a `git push` command would match', () => {
    // `buildAllowedTools()` turns each entry into `Bash(<prefix>:*)`, which claude's own CLI
    // matches as a STARTS-WITH prefix on the whole shell command — so the guard is "no entry is a
    // prefix of a push command", not merely "no entry literally equals git push".
    const pushCommands = ['git push', 'git push origin main', 'git push --force', 'git push -u origin HEAD'];
    for (const entry of bashAllowlist()) {
      const prefix = entry.trim();
      for (const cmd of pushCommands) {
        expect(cmd.startsWith(prefix)).toBe(false);
      }
    }
  });

  it('carries a subcommand on every script/task-runner entry — no bare runner prefix', () => {
    // A bare `'npm run'`/`'pnpm run'`/`'yarn run'`/`'make'` is a prefix that also matches whatever
    // OTHER script a target repo's own package.json/Makefile defines under it — including a
    // `deploy`/`release`/`publish` script. Asserted on the data (every entry, verbatim), not on the
    // comment above it: a comment can say "gate-shaped only" while the array still holds the bare
    // form. `npm install`/`ci` (and the pnpm/yarn equivalents) are the one named exception — they
    // are not runner prefixes at all, so they never appear in this list.
    const bareRunnerPrefixes = ['npm run', 'pnpm run', 'yarn run', 'make'];
    for (const entry of bashAllowlist()) {
      expect(bareRunnerPrefixes).not.toContain(entry.trim());
    }
  });
});
