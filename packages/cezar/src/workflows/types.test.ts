import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_IMPLEMENTATION_WORKFLOW,
  BRIEFS_DIR,
  DEFAULT_ALLOWED_TOOLS,
  FILE_WRITE_RECIPE,
  RECORD_READ_RECIPE,
  parseReviewVerdict,
  SPEC_TO_DEPLOY_WORKFLOW,
  chainStepNote,
  skillStackOf,
  workflowStepSchema,
} from './types.ts';

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

  it('is the eight-step context → spec → review → implement → tests → push → document → deploy chain', () => {
    expect(SPEC_TO_DEPLOY_WORKFLOW.name).toBe('spec-to-deploy');
    expect(SPEC_TO_DEPLOY_WORKFLOW.source).toBe('built-in');
    // Grew from six to eight on 2026-08-20 (spec
    // `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`): `context` split out of
    // the combined read+write step, and `review-spec` added before anything acts on the spec.
    expect(SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id)).toEqual([
      'context',
      'spec',
      'review-spec',
      'implement',
      'run-tests',
      'commit-push',
      'document',
      'deploy',
    ]);
  });

  it('gathers the record in its OWN step, which writes a brief and no spec', () => {
    const context = stepById('context');
    // The point of the split: the reading step is where fan-out belongs (it is the
    // exploration-bound one), and the writing step gets a clean window.
    expect(context?.allowedTools).toContain('Task');
    expect(context?.prompt).toContain(RECORD_READ_RECIPE);
    expect(context?.prompt).toContain(BRIEFS_DIR);
    expect(context?.prompt).not.toContain('CEZ:SPEC_PATH');
    expect(canPush(context?.bashAllowlist)).toBe(false);
  });

  it('the spec step now writes FROM the brief and no longer runs the record sweep', () => {
    const spec = stepById('spec');
    expect(spec?.prompt).toContain(BRIEFS_DIR);
    expect(spec?.prompt).toContain('CEZ:SPEC_PATH');
    // The sweep moved to `context`. If this ever comes back, the split has been undone.
    expect(spec?.prompt).not.toContain(RECORD_READ_RECIPE);
  });

  it('review-spec cannot edit what it reviews, and loops back to the spec step', () => {
    const review = stepById('review-spec');
    // The load-bearing guarantee of the whole review: no write tools, at all. A reviewer that
    // can edit the spec does not review it, and the loop-back stops meaning anything.
    expect(review?.allowedTools).not.toContain('Write');
    expect(review?.allowedTools).not.toContain('Edit');
    expect(canPush(review?.bashAllowlist)).toBe(false);
    // Bounded, and backwards — `stepsIssue` enforces the direction, this pins the target.
    expect(review?.onFail).toEqual({ retry: 'spec', max: 2 });
    expect(review?.requiresApproval).toBe(true);
    // Both verdicts have to be spelled out, or the reviewer cannot know what to emit.
    expect(review?.prompt).toContain('CEZ:REVIEW=pass');
    expect(review?.prompt).toContain('CEZ:REVIEW=revise');
  });

  it('only the review step is gated — the gate is not quietly on the whole chain', () => {
    const gated = SPEC_TO_DEPLOY_WORKFLOW.steps.filter((s) => s.requiresApproval).map((s) => s.id);
    expect(gated).toEqual(['review-spec']);
  });

  it('the record-reading step cannot reach a shell beyond kb + read-only git', () => {
    // Was the combined `spec` step until the 2026-08-20 split; the allowlist travelled with the
    // reading job, which is what it was always describing.
    const spec = stepById('context');
    // No install/build/push verbs — a spec-writing pass has no business running them.
    // `sed -n`, `ls` and `cezar todo list` joined the list with the batched record-read recipe
    // (spec 2026-08-20-agent-round-trip-batching-and-fanout, Phase 3). Every entry is still a
    // READ, which is the property that actually matters here — asserted below as a rule rather
    // than trusted to the literal.
    expect(spec?.bashAllowlist).toEqual([
      'git log',
      'git show',
      'git status',
      'git diff',
      'cez kb',
      'sed -n',
      'ls',
      'cezar todo list',
    ]);
    expect(canPush(spec?.bashAllowlist)).toBe(false);
    for (const entry of spec?.bashAllowlist ?? []) {
      // No mutation, no network, no build. `git status`/`git log`/`git show` are queries;
      // `sed -n` is print-only (no `-i`); `ls` and `cezar todo list` read.
      expect(/^(git (log|show|status|diff)|cez kb|sed -n|ls|cezar todo list)$/.test(entry.trim())).toBe(true);
    }
  });

  /**
   * Sub-agent fan-out is granted ASYMMETRICALLY, and the asymmetry is the whole design
   * (spec `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 4 / §5).
   *
   * `spec` and `document` are exploration-bound — measured at 32× and 3.3× model-time to
   * tool-time on run `ec6e8e06` — and their reads are independent, so overlapping them is free
   * wall clock. `implement` is serial and FILE-MUTATING: concurrent writers in one worktree
   * corrupt each other, and there is no per-agent isolation *inside* a step the way
   * `2026-08-19-parallel-workspace-runs-worktrees.md` gave runs one. `run-tests` is
   * execution-bound (617 of its 826 s were `npm`) and parallel agents would contend for the same
   * `node_modules`. `commit-push` shares one git index lock. Granting `Task` to any of those
   * three would be a measured pessimisation, not a missing feature — so this test asserts their
   * ABSENCE as hard as it asserts the other two's presence.
   */
  it('grants Task fan-out to the read-heavy steps ONLY (context, document)', () => {
    // `context` inherited this from the combined step in the 2026-08-20 split — and it is the
    // more honest home for it: fan-out belongs to the step that READS, and `spec`, which now only
    // writes, deliberately lost it.
    expect(stepById('context')?.allowedTools).toContain('Task');
    expect(stepById('document')?.allowedTools).toContain('Task');
    for (const id of ['spec', 'review-spec', 'implement', 'run-tests', 'commit-push', 'deploy']) {
      expect(stepById(id)?.allowedTools ?? []).not.toContain('Task');
    }
    // The default set stays fan-out-free: `implement`, `run-tests` and `deploy` read it, and a
    // `Task` added there would silently hand a mutating step concurrent writers.
    expect(DEFAULT_ALLOWED_TOOLS).not.toContain('Task');
  });

  it('tells the two fanned-out steps to keep their sub-agents read-only and write nothing', () => {
    for (const id of ['context', 'document']) {
      const prompt = stepById(id)?.prompt ?? '';
      expect(prompt).toContain('READ-ONLY');
      expect(prompt).toMatch(/THREE sub-agents|three READ-ONLY sub-agents/);
    }
    // The reading step's own product is its citations; a brief assembled from summaries loses them.
    expect(stepById('context')?.prompt).toContain('YOU write the brief');
  });

  /**
   * The GRANT is not what produces fan-out — the prompt's FORM is (spec
   * `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`, Phase 3).
   *
   * Measured on this box: `context` states it as its own imperative paragraph — named jobs, then
   * rules — and dispatched sub-agents on 3 of 3 runs. `document` held the identical `Task` grant
   * behind a subordinate clause inside the batched-read sentence and dispatched on 0 of 2
   * (`c10864d1` 38 own calls, `7c2dd8f0` 45; both `sub 0`, once the meter could see a dispatch at
   * all). Same tool, same model, same doctrine on both sides. So this asserts the FORM, not just
   * the presence of the word `Task`: the three jobs named as jobs, and the bound that stops a
   * sub-agent being spawned to read one file.
   */
  it('states fan-out as an imperative paragraph in BOTH read-heavy steps, not as an aside', () => {
    // These prompts are hard-wrapped arrays of lines, so a sentence spans a newline. Assert on
    // the flowed text — the sentence is the contract, its wrap column is not.
    const flowed = (id: string) => (stepById(id)?.prompt ?? '').replace(/\s+/g, ' ');
    for (const id of ['context', 'document']) {
      const prompt = flowed(id);
      // Its own paragraph, in the same voice, in both steps.
      expect(prompt, id).toContain('Then go WIDE.');
      expect(prompt, id).toContain('in parallel in a single turn');
      expect(prompt, id).toContain('Rules that make this safe rather than merely fast:');
      // R4: a sub-agent that reads one file costs more than it saves.
      expect(prompt, id).toContain('worth a minute of work');
      expect(prompt, id).toContain('Do not fan out to read one file');
    }
    // `document` names its three independent reads AS the three jobs, the way `context` does.
    const document = flowed('document');
    expect(document).toContain(
      'What the knowledge base already says, what the spec claims, and what the tracker thinks are three independent questions',
    );
    // It WRITES, so the read-only bound is load-bearing: say why, not just what (R3).
    expect(document).toContain('concurrent writers corrupt each other');
    expect(document).toContain('YOU do all the writing');
  });

  it('opens the record-reading steps with ONE batched, bounded, non-aborting script', () => {
    for (const id of ['context', 'document']) {
      const prompt = stepById(id)?.prompt ?? '';
      expect(prompt).toContain(RECORD_READ_RECIPE);
    }
    // R1: never `set -e` in a probe batch — it hides every section after the first miss.
    expect(RECORD_READ_RECIPE).toContain('set +e');
    expect(RECORD_READ_RECIPE).not.toMatch(/set -e/);
    // R1: a delimiter per section, or the result is an unreadable blob.
    expect(RECORD_READ_RECIPE).toContain('=====');
    // R2: every section is bounded, or the batch floods the context it was meant to save.
    // A bound can be a pipe (`| head -30`) or the command's own count flag (`git log -15`) —
    // both cap the output, which is the property; the shape is not.
    for (const line of RECORD_READ_RECIPE.split('\n')) {
      if (!line.startsWith('say ')) continue;
      expect(line, `unbounded section: ${line}`).toMatch(/head -\d+|tail -\d+|sed -n \d+,\d+p|\s-\d+\b/);
    }
  });

  it('tells run-tests to overlap its npm time and to read the env traps first', () => {
    const prompt = stepById('run-tests')?.prompt ?? '';
    expect(prompt).toContain('BACKGROUND');
    expect(prompt).toContain('run_in_background');
    expect(prompt).toContain('Never background anything that mutates the git index');
    // The measured run paid three full `npm test` runs to rediscover documented traps.
    expect(prompt).toContain('AGENTS.md');
  });

  /**
   * Spec `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`.
   *
   * The old pin here was '`wait` for every one of' — a phrase that read as a mechanism and was
   * not one, since a PID captured in one Bash call is not a child of the next call's shell. What
   * agents actually did with it was guess: 7 blind `sleep N` waits across five measured runs.
   */
  it('makes run-tests wait on the process and never on a guessed duration', () => {
    const prompt = stepById('run-tests')?.prompt ?? '';
    expect(prompt).toContain('never on a guessed duration');
    expect(prompt).toContain('wait for the completion signal');
    // R6, restated after the reword: a backgrounded gate nobody waited on reports against a tree
    // that moved — run `23221162` ended `run-tests` 90 s in, with `npm test` still running.
    expect(prompt).toContain('Never report a gate you did not read');
    expect(prompt).toMatch(/never end your turn while one is still/);
    // L4 — the report must quote an artifact that cannot exist unless the process finished.
    expect(prompt).toContain('QUOTE the');
    expect(prompt).toContain('exit-marker line from each saved log');
    // Every `sleep <n>` the prompt SHOWS sits inside an early-exit loop — the same predicate
    // `runs/stats.ts` scores transcripts with, applied to the prompt that teaches it. A prompt
    // that demonstrated a bare `sleep 30` would teach exactly the defect it forbids.
    for (const line of prompt.split('\n')) {
      if (!/\bsleep\s+[\d.]+/.test(line)) continue;
      expect(line, `unguarded sleep in the run-tests prompt: ${line}`).toMatch(/\b(until|while|for)\b/);
    }
  });

  it('makes implement and run-tests re-slice a saved log instead of re-running the command', () => {
    // The carve-out from the batching doctrine's bounding rule: on run `7c2dd8f0`, 18 repeated
    // expensive calls cost 5.9 min, headed by one test file run 11 times for 11 different filters.
    const runTests = stepById('run-tests')?.prompt ?? '';
    expect(runTests).toContain('rather than re-running the gate');
    expect(runTests).toContain('re-run 11');

    const implement = stepById('implement')?.prompt ?? '';
    expect(implement).toContain('never guess with `sleep N`');
    expect(implement).toContain('instead of re-running the command');
    for (const line of implement.split('\n')) {
      if (!/\bsleep\s+[\d.]+/.test(line)) continue;
      expect(line, `unguarded sleep in the implement prompt: ${line}`).toMatch(/\b(until|while|for)\b/);
    }
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
 * The file-write recipe (spec `.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md`,
 * L1/L3): overrides bypass mode's Bash-first preference FOR FILE MUTATION ONLY, in the three
 * write-heavy steps of this workflow.
 */
describe('FILE_WRITE_RECIPE', () => {
  const stepById = (id: string) => SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === id);

  it('overrides the bypass-mode Bash preference for FILE EDITS in all three write-heavy steps', () => {
    for (const id of ['spec', 'implement', 'document']) {
      expect(stepById(id)?.prompt, id).toContain(FILE_WRITE_RECIPE);
    }
    const t = FILE_WRITE_RECIPE.replace(/\s+/g, ' ');
    // It overrides, explicitly and by name — a rule that does not mention what it overrides loses.
    expect(t).toContain('OVERRIDES');
    expect(t).toContain('for file mutation only');
    // Criterion 2: the WHY travels with the rule, with numbers, so it cannot be deleted as
    // boilerplate. Both figures are DIRECT COUNTS that survive any change to how heredoc bodies are
    // parsed — revision 1 pinned a share (274,926/465,531) that the meter's own implementation then
    // failed to reproduce. Do not put a parse-dependent number in prompt text.
    expect(t).toContain('an edit costs the CHANGE, a heredoc costs the FILE');
    expect(t).toMatch(/360 tool calls, ZERO `Edit`, ZERO `Write`/);
    expect(t).toMatch(/34,845 characters, then 48,618, of which 20,550/);
    // R10: without this the conversion can cost more round trips than it saves characters.
    expect(t).toMatch(/PARALLEL edit calls in ONE turn/);
    // R11: the rule is conditional on how much of the file changes, not on whether it existed.
    expect(t).toContain('when you are genuinely rewriting MOST of a file');
    expect(t).toContain('Judge by how much of the file changes');
    // The carve-outs, or it collides with the doctrine's (correct) shell-first reading rules.
    expect(t).toContain('a file that does not exist yet');
    expect(t).toContain('scripted multi-file transform');
    expect(t).toContain('that rule is about reading, this one is about writing');
    // R2: the recovery path, or a failed match becomes the exact defect this forbids.
    expect(t).toContain('Do NOT fall back to rewriting the whole file');
  });

  it('grants the spec step the editor tool it is now told to use', () => {
    expect(stepById('spec')?.allowedTools).toContain('Edit');
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

/**
 * STEP POST-CONDITIONS (`.ai/specs/2026-08-20-steps-green-only-when-verified.md`). Every step of
 * this workflow used to be green whenever its agent exited without erroring — which is how
 * `commit-push` reported `status=done` on run `23221162` leaving 7 modified and 5 untracked files
 * and no commit, and how deploying one of cezar's two services ended the deploy step green.
 *
 * | Guard | Mutation that must turn it red |
 * |---|---|
 * | `commit-push` verifies everything is committed | delete its `verify` |
 * | `document` does too (it commits the record) | delete its `verify` |
 * | `deploy` verifies ALL services are live | delete its `verify`, or point it at the commit built-in |
 * | The schema rejects an ambiguous `verify` | drop the builtin-XOR-command refinement |
 */
describe('SPEC_TO_DEPLOY_WORKFLOW steps are green only when verified', () => {
  const step = (id: string) => SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === id);

  it('gates commit-push on everything actually being committed', () => {
    expect(step('commit-push')?.verify).toEqual({ builtin: 'everything-committed', max: 1 });
  });

  it('gates document on the same thing — an uncommitted record is not a record', () => {
    expect(step('document')?.verify).toEqual({ builtin: 'everything-committed', max: 1 });
  });

  it('gates deploy on ALL services being deployed, not merely on the step ending', () => {
    expect(step('deploy')?.verify).toEqual({ builtin: 'all-services-deployed', max: 1 });
  });

  it('leaves the steps that have no machine-checkable post-condition alone', () => {
    // Deliberate, not an oversight: a spec's quality is not shell-checkable, and re-running the
    // whole gate suite to verify `run-tests` would double its cost. `commit-push` is what catches
    // the downstream damage — that is the incident's own causal chain.
    for (const id of ['spec', 'implement', 'run-tests']) {
      expect(step(id)?.verify).toBeUndefined();
    }
  });

  it('every declared post-condition names a builtin the runner can actually evaluate', () => {
    // A `verify` naming an unknown builtin is RED at runtime, which would fail the default
    // workflow for everyone. Catch a typo here instead.
    const known = new Set(['everything-committed', 'all-services-deployed']);
    for (const s of SPEC_TO_DEPLOY_WORKFLOW.steps) {
      if (s.verify?.builtin) expect(known.has(s.verify.builtin)).toBe(true);
    }
  });
});

describe('workflowStepSchema — verify', () => {
  const base = { id: 'ship', prompt: 'do it' };

  it('defaults max to 1, so a failed post-condition always gets one re-run', () => {
    const parsed = workflowStepSchema.parse({ ...base, verify: { builtin: 'everything-committed' } });
    expect(parsed.verify?.max).toBe(1);
  });

  it('accepts a plain shell post-condition', () => {
    expect(() => workflowStepSchema.parse({ ...base, verify: { command: 'test -f dist/index.js' } })).not.toThrow();
  });

  it('rejects a verify that names both a builtin and a command', () => {
    expect(() =>
      workflowStepSchema.parse({ ...base, verify: { builtin: 'everything-committed', command: 'true' } }),
    ).toThrow();
  });

  it('rejects a verify that names neither', () => {
    expect(() => workflowStepSchema.parse({ ...base, verify: { max: 2 } })).toThrow();
  });

  it('rejects an unknown builtin at load time rather than at run time', () => {
    expect(() => workflowStepSchema.parse({ ...base, verify: { builtin: 'everything-deployed' } })).toThrow();
  });

  it('keeps a post-conditioned step out of the compact `skills:` form', () => {
    // `skillStackOf` is the inverse of `skillsToSteps`; compacting a step that carries a
    // post-condition would silently drop the post-condition on the next save.
    const plain = { id: 'a', skill: 'a', name: 'a', prompt: '{{task}}' };
    expect(skillStackOf([plain])).toEqual(['a']);
    expect(skillStackOf([{ ...plain, verify: { builtin: 'everything-committed' as const, max: 1 } }])).toBeNull();
  });
});
