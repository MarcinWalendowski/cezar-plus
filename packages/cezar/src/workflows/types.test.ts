import { describe, expect, it } from 'vitest';
import { AUTONOMOUS_IMPLEMENTATION_WORKFLOW, SPEC_TO_DEPLOY_WORKFLOW, chainStepNote } from './types.ts';

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

/**
 * `SPEC_TO_DEPLOY_WORKFLOW` (spec `.ai/specs/2026-08-19-spec-to-deploy-default-workflow.md`): the
 * owner's full pipeline as one chain — read+spec → implement → run-tests → commit-push → document
 * → deploy. Its guards are asymmetric BY DESIGN, so the tests assert exactly that asymmetry rather
 * than one blanket rule:
 *  - `implement`/`run-tests` keep the autonomous workflow's push-free allowlist (shared by
 *    reference) — they can build/test but never reach the remote;
 *  - `commit-push` gets a SCOPED remote grant (git + gh only, incl. `git push`) — owner decision;
 *  - `deploy` is UNRESTRICTED on purpose (owner decision 2026-08-19, "fixed grant").
 */
describe('SPEC_TO_DEPLOY_WORKFLOW pipeline shape', () => {
  const stepById = (id: string) => SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === id);
  const canPush = (allowlist: string[] | undefined) =>
    (allowlist ?? []).some((entry) => 'git push'.startsWith(entry.trim()));

  it('is the six-step read+spec → implement → run-tests → commit-push → document → deploy chain', () => {
    expect(SPEC_TO_DEPLOY_WORKFLOW.name).toBe('spec-to-deploy');
    expect(SPEC_TO_DEPLOY_WORKFLOW.source).toBe('built-in');
    expect(SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id)).toEqual([
      'spec',
      'implement',
      'run-tests',
      'commit-push',
      'document',
      'deploy',
    ]);
  });

  it('spec step reads the record but cannot reach a shell beyond kb + read-only git', () => {
    const spec = stepById('spec');
    // No install/build/push verbs — a spec-writing pass has no business running them.
    expect(spec?.bashAllowlist).toEqual(['git log', 'git show', 'git status', 'cez kb']);
  });

  it('implement and run-tests reuse the autonomous allowlist verbatim, so neither can push', () => {
    // Shared BY REFERENCE, not copied: the sets drift into disagreement the moment one is edited and
    // the other is not, which is exactly the failure this asserts against.
    const auto = AUTONOMOUS_IMPLEMENTATION_WORKFLOW.steps[0]?.bashAllowlist;
    expect(stepById('implement')?.bashAllowlist).toBe(auto);
    expect(stepById('run-tests')?.bashAllowlist).toBe(auto);
    expect(canPush(auto)).toBe(false);
  });

  it('commit-push CAN push (scoped git+gh grant) but is never unrestricted bash', () => {
    const step = stepById('commit-push');
    // The one remote-reaching step — owner decision. It must actually be able to push...
    expect(step?.bashAllowlist).toContain('git push');
    expect(canPush(step?.bashAllowlist)).toBe(true);
    // ...and open/merge a PR...
    expect(step?.bashAllowlist).toContain('gh pr');
    // ...but every entry is a git or gh verb, so it is still an allowlist, not a general shell.
    for (const entry of step?.bashAllowlist ?? []) {
      expect(/^(git|gh) /.test(entry.trim())).toBe(true);
    }
    // And Bash is granted THROUGH that non-empty allowlist, never plain/unrestricted.
    expect(step?.allowedTools).toContain('Bash');
    expect((step?.bashAllowlist ?? []).length).toBeGreaterThan(0);
  });

  it('document step ships its record via the same scoped git+gh grant plus cez kb', () => {
    const doc = stepById('document');
    // Runs after commit-push, so it pushes its own doc/spec/KB commit — but only git/gh + cez kb.
    expect(doc?.bashAllowlist).toContain('git push');
    expect(doc?.bashAllowlist).toContain('cez kb');
    for (const entry of doc?.bashAllowlist ?? []) {
      expect(/^(git|gh|cez) /.test(entry.trim())).toBe(true);
    }
  });

  it('deploy step is deliberately UNRESTRICTED — Bash with no allowlist (fixed-grant decision)', () => {
    const deploy = stepById('deploy');
    // The whole point of this step: run the target repo's own deploy script, whatever shape it
    // takes. `buildAllowedTools()` turns `Bash` + no allowlist into plain, unrestricted `Bash`.
    expect(deploy?.allowedTools).toContain('Bash');
    expect(deploy?.bashAllowlist).toBeUndefined();
  });
});

/**
 * P3 of spec 2026-08-20-chain-integrity-restart-and-continuation: the prompt and the engine have
 * to say the same thing about what `CEZ:DONE` means. The engine now refuses to finish a run whose
 * chain has pending steps; the note is what stops a RESUMED step from restarting its work — or,
 * worse, from reading the handoff file its own earlier turn wrote and declaring the run achieved.
 */
describe('chainStepNote for a resumed step', () => {
  const STEPS = [
    { id: 'spec', name: 'Write the spec' },
    { id: 'implement', name: 'Implement the spec' },
    { id: 'deploy', name: 'Deploy' },
  ];

  it('is byte-for-byte unchanged when the step is not being resumed', () => {
    expect(chainStepNote(STEPS, 1)).toBe(chainStepNote(STEPS, 1, {}));
    expect(chainStepNote(STEPS, 1, { resumed: false })).toBe(chainStepNote(STEPS, 1));
    expect(chainStepNote(STEPS, 1)).not.toMatch(/resumed/);
  });

  it('says the step is being resumed and how much chain is left after it', () => {
    const note = chainStepNote(STEPS, 1, { resumed: true });
    expect(note).toContain('step 2 of 3');
    expect(note).toContain('interrupted by a cezar restart and is being resumed');
    expect(note).toContain('The remaining 1 step(s) of the chain still run after it.');
    // The rule the whole spec enforces, still the closing sentence.
    expect(note).toContain("Only end this turn with CEZ:DONE once step 2's own goal is achieved");
  });

  it('does not promise remaining steps when the resumed step is the chain\'s last', () => {
    const note = chainStepNote(STEPS, 2, { resumed: true });
    expect(note).toContain('is being resumed');
    expect(note).not.toContain('still run after it');
  });

  it('stays undefined for a single-agent-step workflow, resumed or not', () => {
    const single = [{ id: 'work', name: 'Work' }];
    expect(chainStepNote(single, 0, { resumed: true })).toBeUndefined();
  });
});
