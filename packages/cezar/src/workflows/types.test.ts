import { describe, expect, it } from 'vitest';
import { workflowStepDefSchema as contractWorkflowStepDefSchema } from '@loki-labs/cezar-plus-contract';
import { KNOWN_PRESETS_BY_RUNNER, modelConflictsWithRunner } from '../core/model-presets.ts';
import type { RunnerId } from '../core/agent-runner.ts';
import {
  applyReviewStepToggles,
  AUTONOMOUS_IMPLEMENTATION_WORKFLOW,
  BRIEFS_DIR,
  CLASS_CHOICE_BY_RUNNER,
  CLAUDE_CLASS_CHOICE,
  CODEX_CLASS_CHOICE,
  CODEX_ONLY_WORKFLOW_SUFFIX,
  DEFAULT_ALLOWED_TOOLS,
  FILE_WRITE_RECIPE,
  QUICK_TASK_WORKFLOW,
  RECORD_READ_RECIPE,
  REVIEW_CROSS_MODEL_STEP_ID,
  REVIEW_SAME_MODEL_STEP_ID,
  SPEC_TO_DEPLOY_CODEX_NAME,
  parseReviewVerdict,
  pinWorkflowRunner,
  resolveStepModel,
  SPEC_TO_DEPLOY_WORKFLOW,
  TASK_CLASSES,
  UNCLASSIFIABLE_TASK_CLASS,
  chainStepNote,
  skillStackOf,
  stepKind,
  workflowDefSchema,
  workflowStepSchema,
  type WorkflowStepDef,
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

  it('is the ten-step context → spec → two reviews → implement → tests → push → merge → document → deploy chain', () => {
    expect(SPEC_TO_DEPLOY_WORKFLOW.name).toBe('spec-to-deploy');
    expect(SPEC_TO_DEPLOY_WORKFLOW.source).toBe('built-in');
    // Grew from six to eight on 2026-08-20 (spec
    // `.ai/specs/2026-08-20-split-steps-spec-review-and-approval-gate.md`): `context` split out of
    // the combined read+write step, and `review-spec` added before anything acts on the spec.
    // Nine to ten on 2026-08-29 (`.ai/specs/2026-08-29-step-resume-and-two-stage-review.md`, D2):
    // `review-spec-local` runs the same-provider pass BEFORE the cross-provider one, so the
    // expensive reviewer sees a spec that already survived a round.
    expect(SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id)).toEqual([
      'context',
      'spec',
      'review-spec-local',
      'review-spec',
      'implement',
      'run-tests',
      'commit-push',
      'merge',
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

  it('the two SHIPPING steps rewind to run-tests, because their gate is about an earlier step', () => {
    // `tested-revision-shipped` guards both, and it compares HEAD against the tree `run-tests`
    // attested. Once the base moves under a run — six landing on `main` at once, on this repo,
    // routinely — that diff is a fact about run-tests' output, so re-entering the shipping step
    // recomputes it unchanged. Both steps died of exactly this on 2026-08-29: `872b396a` at
    // commit-push (38 files) and `1909f34e` at merge (`base origin/main moved by 17 commit(s)`),
    // each with `document` and `deploy` never run.
    for (const id of ['commit-push', 'merge']) {
      const step = stepById(id);
      expect(step?.verify).toContainEqual({ builtin: 'tested-revision-shipped', max: 1 });
      // Asserted whole, so a dropped `resume` cannot pass as configured.
      expect(step?.onFail).toEqual({ retry: 'run-tests', max: 1, resume: true });
    }
    // Backwards, and to a step that actually exists — `stepsIssue` enforces the direction, this
    // pins that the target is the ATTESTING step and not merely some earlier one.
    const ids = SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id);
    expect(ids.indexOf('run-tests')).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf('run-tests')).toBeLessThan(ids.indexOf('commit-push'));
    expect(ids.indexOf('commit-push')).toBeLessThan(ids.indexOf('merge'));
  });

  it('review-spec cannot edit what it reviews, and loops back to the spec step', () => {
    const review = stepById('review-spec');
    // The load-bearing guarantee of the whole review: no write tools, at all. A reviewer that
    // can edit the spec does not review it, and the loop-back stops meaning anything.
    expect(review?.allowedTools).not.toContain('Write');
    expect(review?.allowedTools).not.toContain('Edit');
    expect(canPush(review?.bashAllowlist)).toBe(false);
    // Bounded, and backwards — `stepsIssue` enforces the direction, this pins the target.
    // `resume: true` (spec 2026-08-29, D1) — the rework re-enters `spec`'s own session rather
    // than starting cold. Asserted as a whole object so a dropped key cannot pass.
    expect(review?.onFail).toEqual({ retry: 'spec', max: 2, resume: true });
    expect(review?.requiresApproval).toBe(true);
    // Both verdicts have to be spelled out, or the reviewer cannot know what to emit.
    expect(review?.prompt).toContain('CEZ:REVIEW=pass');
    expect(review?.prompt).toContain('CEZ:REVIEW=revise');
  });

  /**
   * spec `.ai/specs/2026-08-21-structured-review-targeted-spec-edits.md`: a `revise` verdict must
   * be a change list the `spec` step can apply mechanically, not prose it has to re-derive. This
   * pins the required shape and the two regression guards the spec calls out: the pre-existing
   * "judge the spec, not its prose" discipline must survive, and both verdict markers must still
   * be present so `parseReviewVerdict` keeps working.
   */
  /**
   * `.ai/specs/2026-08-29-step-resume-and-two-stage-review.md`, D2. The cheap pass exists to take
   * defects off the expensive one — which is only defensible because it is a REAL review, not a
   * lighter one: same read-only construction, same verdict vocabulary, same loop-back target.
   */
  it('review-spec-local is a real review — same provider as the writer, read-only, one warm revision', () => {
    const local = stepById('review-spec-local');
    expect(local).toBeDefined();
    // It sits BETWEEN the writer and the external reviewer. Order is the whole mechanism: after
    // `review-spec` it would absorb nothing, and before `spec` it would have nothing to read.
    const ids = SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id);
    expect(ids.indexOf('review-spec-local')).toBe(ids.indexOf('spec') + 1);
    expect(ids.indexOf('review-spec')).toBe(ids.indexOf('review-spec-local') + 1);
    // Same runner AND model as the writer — that pairing is what lets its loop-back resume
    // `spec` at all (`loopBackResumeDecision`'s `backend-changed` guard).
    expect(local?.runner).toBe(stepById('spec')?.runner);
    expect(local?.model).toBe(stepById('spec')?.model);
    // Read-only by construction, exactly as `review-spec` is.
    expect(local?.allowedTools).not.toContain('Write');
    expect(local?.allowedTools).not.toContain('Edit');
    expect(canPush(local?.bashAllowlist)).toBe(false);
    // ONE warm revision, and its own budget — `retriesUsed` is keyed by step id, so this does not
    // spend `review-spec`'s two.
    expect(local?.onFail).toEqual({ retry: 'spec', max: 1, resume: true });
    // The human gate stays on exactly one step.
    expect(local?.requiresApproval).toBeUndefined();
    // Same vocabulary, or `parseReviewVerdict` cannot read it.
    expect(local?.prompt).toContain('CEZ:REVIEW=pass');
    expect(local?.prompt).toContain('CEZ:REVIEW=revise');
    expect(local?.prompt).toContain('FILE:');
    expect(local?.prompt).toContain('SECTION:');
    expect(local?.prompt).toContain('CHANGE:');
  });

  it('review-spec is required to write its `revise` verdict as a FILE/SECTION/CHANGE list', () => {
    const review = stepById('review-spec');
    expect(review?.prompt).toContain('FILE:');
    expect(review?.prompt).toContain('SECTION:');
    expect(review?.prompt).toContain('CHANGE:');
    // The structural-rewrite escape hatch — the one case re-emitting the whole file is correct.
    expect(review?.prompt).toContain('structural rewrite');
    expect(review?.prompt).toContain('CEZ:REVIEW=pass');
    expect(review?.prompt).toContain('CEZ:REVIEW=revise');
    expect(review?.prompt).toContain(
      'Judge the spec, not its prose. `revise` is for a spec that is wrong, incomplete against the',
    );
  });

  it('only the review step is gated — the gate is not quietly on the whole chain', () => {
    const gated = SPEC_TO_DEPLOY_WORKFLOW.steps.filter((s) => s.requiresApproval).map((s) => s.id);
    expect(gated).toEqual(['review-spec']);
  });

  /**
   * The per-step model policy (spec `.ai/specs/2026-08-21-per-step-model-policy.md`): sonnet
   * everywhere, opus on the one judgement step. Asserted against the step list BY IDENTITY and
   * against a count, because the interesting failure here is vacuous rather than loud — a
   * `for (const s of steps)` over a renamed, dropped or emptied step list passes while asserting
   * nothing at all. `runAgentStep` reads `step.model ?? input.model`, so a step that silently
   * lost its `model` does not fail: it quietly falls back to whatever the composer picked.
   */
  it('pins the two authoring steps to opus and every other step to sonnet', () => {
    const models = SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => [s.id, s.model] as const);
    expect(models).toEqual([
      ['context', 'sonnet'],
      ['spec', 'opus'],
      ['review-spec-local', 'opus'],
      ['review-spec', 'gpt-5.6-sol'],
      ['implement', 'sonnet'],
      ['run-tests', 'sonnet'],
      ['commit-push', 'sonnet'],
      ['merge', 'sonnet'],
      ['document', 'sonnet'],
      ['deploy', 'sonnet'],
    ]);
    // The asymmetry itself, stated from the other side: opus is on exactly the two judgement
    // steps, and no step is left unpinned to fall through to the composer's pick.
    // TWO opus steps since 2026-08-29: the writer and the same-provider reviewer in front of the
    // cross-provider one. The count is the point — `review-spec`'s effort came DOWN to `high` in
    // the same change, and it is only defensible because this second opus pass exists.
    expect(models.filter(([, m]) => m === 'opus').map(([id]) => id)).toEqual(['spec', 'review-spec-local']);
    expect(models.filter(([, m]) => !m)).toEqual([]);
  });

  /**
   * "Always opus" has to survive a run started on ANOTHER runner, and the model pin alone does
   * not: `opus` names no model codex can serve, so `RunManager.modelForBackend` drops it and the
   * step would fall through to codex's default. The runner pin is the half that makes the owner's
   * instruction (2026-08-22, "writing spec + spec review should be by opus always") true rather
   * than true-on-Claude-runs.
   *
   * The complement is asserted too: every OTHER step must stay runner-free, because those are the
   * ones the run's own runner is allowed to choose ("the rest can be load balanced by codex or
   * claude sonnet"). A stray runner pin there would quietly disable that.
   */
  it('pins the review runner and leaves construction steps load-balanced', () => {
    const runners = SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => [s.id, s.runner] as const);
    expect(runners.filter(([, r]) => r !== undefined)).toEqual([
      ['spec', 'claude'],
      ['review-spec-local', 'claude'],
      ['review-spec', 'codex'],
    ]);
    // Count-anchored, so a renamed or dropped step list cannot make this vacuous.
    expect(runners.filter(([, r]) => r === undefined).map(([id]) => id)).toEqual([
      'context',
      'implement',
      'run-tests',
      'commit-push',
      'merge',
      'document',
      'deploy',
    ]);
  });

  /**
   * The structural guard for the 2026-08-22 outage: a step must never pin a model its own pinned
   * runner cannot serve. Five production runs reported eight green steps having done nothing
   * because `sonnet` reached codex and codex answered 400 on every turn
   * (`.ai/specs/2026-08-22-failed-turn-reads-as-done.md`).
   *
   * This checks the pairs the workflow FIXES. A step with no runner pin is deliberately skipped:
   * its runner is not knowable here, and that case is handled at run time by
   * `RunManager.modelForBackend` instead of being forbidden at authoring time.
   */
  it('never pins a model the step\'s own runner cannot serve', () => {
    const pinned = SPEC_TO_DEPLOY_WORKFLOW.steps.filter((s) => s.runner && s.model);
    expect(pinned.length).toBeGreaterThan(0); // floor: the assertion below must exercise something
    for (const step of pinned) {
      expect({ id: step.id, conflicts: modelConflictsWithRunner(step.model!, step.runner!) }).toEqual({
        id: step.id,
        conflicts: false,
      });
    }
  });

  /**
   * `.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`, Phase 1: `run-tests` alone gets an
   * `effort` ceiling. Every other step must stay `undefined` — a step that silently gained one
   * would be capped on reasoning depth with no reviewer having decided that, the same vacuous-
   * failure shape the model-policy test above guards against.
   */
  it('caps run-tests to medium effort, sets both review passes to high, and leaves every other step unset', () => {
    const efforts = SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => [s.id, s.effort] as const);
    expect(efforts).toEqual([
      ['context', undefined],
      ['spec', undefined],
      ['review-spec-local', 'high'],
      ['review-spec', 'high'],
      ['implement', undefined],
      ['run-tests', 'medium'],
      ['commit-push', undefined],
      ['merge', undefined],
      ['document', undefined],
      ['deploy', undefined],
    ]);
  });

  it('names models the step\'s effective runner actually offers, so a typo cannot fall through', () => {
    // `modelConflictsWithRunner` fails open on an unknown id and `normalizeModelForBackend` would
    // refuse it only at run time — on the box, mid-chain. Catch it here instead.
    //
    // **Amended 2026-08-22.** This used to assert `step.runner` was undefined on every step and
    // check every model against claude's presets. Both halves of that were premise, not intent:
    // `spec` and `review-spec` now pin `runner: 'claude'` so their opus stays opus on a codex run
    // (`.ai/specs/2026-08-22-failed-turn-reads-as-done.md`). The intent — a step never names a
    // model its own runner cannot serve — is unchanged and is what is asserted now.
    const checked: string[] = [];
    for (const step of SPEC_TO_DEPLOY_WORKFLOW.steps) {
      // An unpinned step runs on the RUN's runner, which is claude by default; a pinned one is
      // checked against what it actually pinned.
      const runner = step.runner ?? 'claude';
      const presets = KNOWN_PRESETS_BY_RUNNER[runner];
      expect(presets.length).toBeGreaterThan(0);
      expect({ id: step.id, offered: presets.includes(step.model as string) }).toEqual({
        id: step.id,
        offered: true,
      });
      checked.push(step.id);
    }
    // Floor: a loop over an emptied or renamed step list would otherwise assert nothing at all.
    expect(checked).toEqual(SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id));
    expect(checked.length).toBe(10);
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

  /**
   * `.ai/specs/2026-08-21-run-tests-reasoning-ceiling.md`, Phase 2: the diagnostic-depth ceiling
   * ("stop once a control proves not-mine") and the output-discipline clause ("quote verbatim,
   * never re-explain the diff") — the behavioral lever alongside Phase 1's mechanical `effort` cap.
   */
  it('tells run-tests to stop diagnosing once a control proves the failure is not mine, and to quote rather than narrate', () => {
    const prompt = stepById('run-tests')?.prompt ?? '';
    expect(prompt).toContain('not mine');
    expect(prompt).toContain('Stop there');
    expect(prompt).toMatch(/does not contain this run's\s*\nchange/);
    expect(prompt).toContain('cezar todo add');
    expect(prompt).toContain('Report pass/fail plainly');
    expect(prompt).toContain('Quote the');
    expect(prompt).toContain('never re-explain what the diff changed');
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

  /**
   * spec `.ai/specs/2026-08-24-manual-deploy-not-a-bug.md` D1: the `deploy` step's unrestricted
   * Bash (above) makes the manual-target gate advisory unless the prompt itself refuses. Without
   * this paragraph an agent following "DEPLOY it" to the letter activates a target the owner marked
   * `manual: true`, the probe goes green, and the postcondition reports success: the exact
   * workaround the gate exists to forbid.
   */
  it('deploy prompt reads .ai/deploy-targets.json first and refuses a manual target', () => {
    const deploy = stepById('deploy');
    expect(deploy?.prompt).toContain('.ai/deploy-targets.json');
    expect(deploy?.prompt).toContain('"manual": true');
    expect(deploy?.prompt).toMatch(/must\s+(not|NOT)\s+deploy/);
    expect(deploy?.prompt).toContain('work around it');
    // The park has to be framed as correct, or the agent's own report reads it as a failure to fix.
    expect(deploy?.prompt).toContain('park for a human');
  });
});

/**
 * `applyReviewStepToggles` (`.ai/specs/2026-08-30-composer-review-step-toggles.md`) — the
 * composer's per-run opt-out of `spec-to-deploy`'s two review stages.
 */
describe('applyReviewStepToggles', () => {
  const ids = (def: { steps: readonly { id: string }[] }) => def.steps.map((s) => s.id);

  it('drops only review-spec-local when reviewSameModel is false', () => {
    const result = applyReviewStepToggles(SPEC_TO_DEPLOY_WORKFLOW, { reviewSameModel: false });
    expect(ids(result)).not.toContain(REVIEW_SAME_MODEL_STEP_ID);
    expect(ids(result)).toContain(REVIEW_CROSS_MODEL_STEP_ID);
    expect(ids(result).length).toBe(SPEC_TO_DEPLOY_WORKFLOW.steps.length - 1);
  });

  it('drops only review-spec when reviewCrossModel is false', () => {
    const result = applyReviewStepToggles(SPEC_TO_DEPLOY_WORKFLOW, { reviewCrossModel: false });
    expect(ids(result)).toContain(REVIEW_SAME_MODEL_STEP_ID);
    expect(ids(result)).not.toContain(REVIEW_CROSS_MODEL_STEP_ID);
    expect(ids(result).length).toBe(SPEC_TO_DEPLOY_WORKFLOW.steps.length - 1);
  });

  it('drops both when both toggles are false, leaving spec followed directly by implement', () => {
    const result = applyReviewStepToggles(SPEC_TO_DEPLOY_WORKFLOW, {
      reviewSameModel: false,
      reviewCrossModel: false,
    });
    expect(ids(result)).not.toContain(REVIEW_SAME_MODEL_STEP_ID);
    expect(ids(result)).not.toContain(REVIEW_CROSS_MODEL_STEP_ID);
    const specAt = ids(result).indexOf('spec');
    expect(ids(result)[specAt + 1]).toBe('implement');
  });

  it('is a no-op (same object reference) when neither toggle is false', () => {
    expect(applyReviewStepToggles(SPEC_TO_DEPLOY_WORKFLOW, {})).toBe(SPEC_TO_DEPLOY_WORKFLOW);
    expect(
      applyReviewStepToggles(SPEC_TO_DEPLOY_WORKFLOW, {
        reviewSameModel: true,
        reviewCrossModel: true,
      }),
    ).toBe(SPEC_TO_DEPLOY_WORKFLOW);
  });

  it('is a no-op on a workflow that carries neither step id', () => {
    expect(
      applyReviewStepToggles(QUICK_TASK_WORKFLOW, { reviewSameModel: false, reviewCrossModel: false }),
    ).toBe(QUICK_TASK_WORKFLOW);
  });

  it('leaves every other step, and their order, untouched', () => {
    const result = applyReviewStepToggles(SPEC_TO_DEPLOY_WORKFLOW, { reviewSameModel: false });
    expect(ids(result)).toEqual(
      SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id).filter((id) => id !== REVIEW_SAME_MODEL_STEP_ID),
    );
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
    expect(step('commit-push')?.verify).toEqual([
      { builtin: 'everything-committed', max: 1 },
      { builtin: 'tested-revision-shipped', max: 1 },
    ]);
  });

  it('gates document on the same thing — an uncommitted record is not a record', () => {
    expect(step('document')?.verify).toEqual([
      { builtin: 'everything-committed', max: 1 },
      { builtin: 'merged-into-base', max: 1 },
    ]);
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
    const known = new Set(['everything-committed', 'all-services-deployed', 'tested-revision-shipped', 'merged-into-base']);
    for (const s of SPEC_TO_DEPLOY_WORKFLOW.steps) {
      const entries = s.verify ? (Array.isArray(s.verify) ? s.verify : [s.verify]) : [];
      for (const entry of entries) if (entry.builtin) expect(known.has(entry.builtin)).toBe(true);
    }
  });
});

/**
 * D14 of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`: which steps have to hold a slot in
 * the `maxHeavySteps` semaphore is DECLARED on the step, never inferred from its name. Types
 * only at this stage — nothing takes the semaphore yet.
 */
describe('workflowStepSchema — heavy', () => {
  const base = { id: 'run-tests', command: 'npm test' };

  it('is absent by default, so every existing step and workflow file keeps today\'s behaviour', () => {
    expect(workflowStepSchema.parse(base).heavy).toBeUndefined();
  });

  it('round-trips an explicit true and an explicit false', () => {
    // `false` must survive as `false` rather than collapsing to absent: a chain that
    // deliberately opts a normally-heavy step OUT is saying something a missing key cannot.
    expect(workflowStepSchema.parse({ ...base, heavy: true }).heavy).toBe(true);
    expect(workflowStepSchema.parse({ ...base, heavy: false }).heavy).toBe(false);
  });

  it('rejects a non-boolean rather than coercing it', () => {
    // Loud at load time. A truthy string silently becoming `true` would make a workflow file
    // claim a slot in a semaphore its author never asked for.
    expect(() => workflowStepSchema.parse({ ...base, heavy: 'yes' })).toThrow();
  });

  it('is not inferred from the step\'s name — a step called run-tests is heavy only if it says so', () => {
    // The negative control for "declared, never inferred": these two steps differ ONLY in the
    // declaration, and the schema must not read anything into `id`/`name`. A name-match
    // implementation would make the first of these heavy and pass a test that only checked the
    // second.
    expect(workflowStepSchema.parse({ id: 'run-tests', name: 'run-tests', command: 'npm test' }).heavy).toBeUndefined();
    expect(workflowStepSchema.parse({ id: 'stroll', name: 'stroll', command: 'true', heavy: true }).heavy).toBe(true);
  });

  it('the wire (contract) schema keeps it too, so a step survives a save round-trip', () => {
    // This assertion exists because `contract-parity.workflows.test.ts` CANNOT catch it. That
    // guard compares the two shapes with a mutual assignability check, and an added optional
    // property stays assignable in both directions — measured: adding `heavy` to the server
    // schema alone leaves `npm run typecheck` green (adding a REQUIRED field produces 147
    // errors, so the guard is live, just blind to this). `GET /workflows` serves the server's
    // own def verbatim, so the flag is on the wire either way; what a missing mirror would cost
    // is the way back — a consumer rebuilding a step from the contract type drops `heavy`, and
    // the workflow silently stops being heavy on its next save.
    const parsed = contractWorkflowStepDefSchema.parse({ id: 'run-tests', command: 'npm test', heavy: true });
    expect(parsed.heavy).toBe(true);
    // Negative control on the mirror itself: it must not have been added as something that
    // swallows the value (a `.catch(undefined)`, say) — an explicit `false` has to survive as
    // `false`, exactly as it does on the server side above.
    expect(contractWorkflowStepDefSchema.parse({ id: 'a', command: 'true', heavy: false }).heavy).toBe(false);
  });

  it('survives a workflow-def round-trip, which is how a persisted run reads it back', () => {
    // `RunStore` persists `workflowDef` and re-parses it on load (`runs/store.ts`). A step flag
    // the def schema dropped would be lost on every restart.
    const def = workflowDefSchema.parse({
      name: 'gates',
      source: 'built-in',
      steps: [{ id: 'run-tests', command: 'npm test', heavy: true }],
    });
    expect(def.steps[0]?.heavy).toBe(true);
  });
});

describe('workflowStepSchema — verify', () => {
  const base = { id: 'ship', prompt: 'do it' };

  it('defaults max to 1, so a failed post-condition always gets one re-run', () => {
    const parsed = workflowStepSchema.parse({ ...base, verify: { builtin: 'everything-committed' } });
    expect((Array.isArray(parsed.verify) ? parsed.verify[0] : parsed.verify)?.max).toBe(1);
  });

  it('accepts a plain shell post-condition', () => {
    expect(() => workflowStepSchema.parse({ ...base, verify: { command: 'test -f dist/index.js' } })).not.toThrow();
  });

  it('accepts an ordered list of post-conditions and defaults every max independently', () => {
    const parsed = workflowStepSchema.parse({
      ...base,
      verify: [{ builtin: 'everything-committed' }, { command: 'true', max: 2 }],
    });
    expect(parsed.verify).toEqual([
      { builtin: 'everything-committed', max: 1 },
      { command: 'true', max: 2 },
    ]);
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

/**
 * The codex half of the per-step model policy
 * (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`).
 *
 * Before this, `spec-to-deploy` named a Claude model on all eight steps, `modelForBackend` dropped
 * six of them on a codex run as another runner's id, and those steps fell through to codex's own
 * default — measured on `prod-host` as `gpt-5.6-sol` at `reasoningEffort: null`: the most
 * expensive model in the catalog at its shallowest setting, for `Commit & push` and `Deploy`
 * alike.
 */
describe('per-step model and effort, per runner', () => {
  const stepOf = (id: string): WorkflowStepDef => {
    const step = SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === id);
    expect(step, `spec-to-deploy has no step "${id}"`).toBeDefined();
    return step!;
  };

  describe('resolveStepModel (D1)', () => {
    it('takes the byRunner pair for the backend that will run the step', () => {
      const step = stepOf('implement');
      expect(resolveStepModel(step, 'codex')).toEqual({ model: 'gpt-5.6-luna', effort: 'xhigh' });
    });

    it('leaves every other backend on the step\'s own model and effort', () => {
      // The negative control on the test above: without it, "the codex table applies" is equally
      // provable by a resolver that returns the codex pair for everything.
      const step = stepOf('implement');
      expect(resolveStepModel(step, 'claude')).toEqual({ model: 'sonnet', effort: undefined });
      expect(resolveStepModel(step, 'opencode')).toEqual({ model: 'sonnet', effort: undefined });
    });

    it('is unchanged for a step that names no byRunner, on either backend', () => {
      // The other negative control, and the one that guards every workflow this spec never
      // touched: a step with no override must resolve identically to what the old
      // `step.model ?? input.model` / `step.effort` pair produced.
      const plain: WorkflowStepDef = { id: 'x', prompt: '{{task}}', model: 'sonnet', effort: 'high' };
      expect(resolveStepModel(plain, 'codex')).toEqual({ model: 'sonnet', effort: 'high' });
      expect(resolveStepModel(plain, 'claude')).toEqual({ model: 'sonnet', effort: 'high' });
    });

    it('falls back to the run-level model, and never invents a run-level effort', () => {
      const bare: WorkflowStepDef = { id: 'x', prompt: '{{task}}' };
      expect(resolveStepModel(bare, 'codex', 'gpt-5.6-sol')).toEqual({
        model: 'gpt-5.6-sol',
        effort: undefined,
      });
    });

    it('does not half-apply an override that names only an effort', () => {
      // The pair is the unit. An override carrying only `effort` must still take the step's model,
      // not leave the model undefined — the shape that would drop a pin and keep a ceiling.
      const step: WorkflowStepDef = {
        id: 'x',
        prompt: '{{task}}',
        model: 'sonnet',
        effort: 'low',
        byRunner: { codex: { effort: 'max' } },
      };
      expect(resolveStepModel(step, 'codex')).toEqual({ model: 'sonnet', effort: 'max' });
    });
  });

  describe('the spec-to-deploy table (D2)', () => {
    it('names a codex model and effort on every step that does not pin the claude runner', () => {
      // Asserted as a WHOLE rather than step by step, so a further step added later without a
      // codex pin reddens this instead of silently inheriting codex's default.
      const table = Object.fromEntries(
        SPEC_TO_DEPLOY_WORKFLOW.steps.map((step) => [step.id, resolveStepModel(step, 'codex')]),
      );
      expect(table).toEqual({
        context: { model: 'gpt-5.6-terra', effort: 'medium' },
        // `spec` and `review-spec` pin `runner: 'claude'`, so they never reach a codex backend at
        // all — owner instruction 2026-08-22, "writing spec + spec review should be by opus
        // always". They keep the Claude pair even when asked about codex.
        spec: { model: 'gpt-5.6-sol', effort: 'medium' },
        // `review-spec-local` pins the claude runner like `spec` does, and names `CODEX_REVIEW`
        // as its codex fallback — so on codex the two review passes resolve to the same row. That
        // is deliberate: the cheap pass is cheap because of WHERE it sits, not because it is a
        // weaker model, and a codex-only run has no second provider to be cheap against.
        'review-spec-local': { model: 'gpt-5.6-sol', effort: 'high' },
        'review-spec': { model: 'gpt-5.6-sol', effort: 'high' },
        implement: { model: 'gpt-5.6-luna', effort: 'xhigh' },
        'run-tests': { model: 'gpt-5.6-luna', effort: 'medium' },
        'commit-push': { model: 'gpt-5.6-luna', effort: 'medium' },
        merge: { model: 'gpt-5.6-luna', effort: 'medium' },
        document: { model: 'gpt-5.6-luna', effort: 'high' },
        deploy: { model: 'gpt-5.6-luna', effort: 'medium' },
      });
    });

    it('pins spec to Claude fallback and review to Codex SOL', () => {
      expect(stepOf('spec').runner).toBe('claude');
      expect(stepOf('spec').byRunner?.codex).toEqual({ model: 'gpt-5.6-sol', effort: 'medium' });
      expect(stepOf('review-spec').runner).toBe('codex');
      expect(stepOf('review-spec').byRunner?.claude).toEqual({ model: 'opus', effort: 'xhigh' });
    });

    it('every codex model it names is one the picker offers', () => {
      // `KNOWN_PRESETS_BY_RUNNER.codex` is the 5.6 family only (owner: "in codex use only 5.6").
      // A model named here but absent there would be a workflow the composer cannot express.
      for (const step of SPEC_TO_DEPLOY_WORKFLOW.steps) {
        const model = step.byRunner?.codex?.model;
        if (!model) continue;
        expect(KNOWN_PRESETS_BY_RUNNER.codex, `${step.id} names ${model}`).toContain(model);
        expect(modelConflictsWithRunner(model, 'codex')).toBe(false);
      }
    });
  });

  describe('escalation (D4) — "Terra/Sol Medium failed → Sol High/Max"', () => {
    const terraMedium: WorkflowStepDef = {
      id: 'x',
      prompt: '{{task}}',
      byRunner: { codex: { model: 'gpt-5.6-terra', effort: 'medium' } },
    };

    it('climbs terra-medium to sol high, then sol max, and stops there', () => {
      expect(resolveStepModel(terraMedium, 'codex', undefined, 0)).toEqual({
        model: 'gpt-5.6-terra',
        effort: 'medium',
      });
      expect(resolveStepModel(terraMedium, 'codex', undefined, 1)).toEqual({
        model: 'gpt-5.6-sol',
        effort: 'high',
      });
      expect(resolveStepModel(terraMedium, 'codex', undefined, 2)).toEqual({
        model: 'gpt-5.6-sol',
        effort: 'max',
      });
      // `ultra` is never reached — "Sol Ultra: basically never", and the enum omits it.
      expect(resolveStepModel(terraMedium, 'codex', undefined, 9)).toEqual({
        model: 'gpt-5.6-sol',
        effort: 'max',
      });
    });

    it('climbs sol-medium the same way', () => {
      const solMedium: WorkflowStepDef = {
        id: 'x',
        prompt: '{{task}}',
        byRunner: { codex: { model: 'gpt-5.6-sol', effort: 'medium' } },
      };
      expect(resolveStepModel(solMedium, 'codex', undefined, 1)).toEqual({
        model: 'gpt-5.6-sol',
        effort: 'high',
      });
    });

    it('does NOT climb a luna row, however many times it failed', () => {
      // The direction that matters, and the one a "climb on any failure" ladder gets wrong: a
      // failing tiny task must not end up on the most expensive model in the catalog.
      const implement = stepOf('implement');
      for (const priorFailures of [1, 2, 5]) {
        expect(resolveStepModel(implement, 'codex', undefined, priorFailures)).toEqual({
          model: 'gpt-5.6-luna',
          effort: 'xhigh',
        });
      }
      expect(resolveStepModel(stepOf('commit-push'), 'codex', undefined, 3)).toEqual({
        model: 'gpt-5.6-luna',
        effort: 'medium',
      });
    });

    it('leaves a claude step alone — the ladder is codex-only by construction', () => {
      // `sonnet` at no effort is not an escalatable rung, so a Claude step cannot be pushed onto
      // a codex model by failing. Nothing keys on the backend id to achieve that; it falls out of
      // the rungs being named by model.
      expect(resolveStepModel(stepOf('implement'), 'claude', undefined, 3)).toEqual({
        model: 'sonnet',
        effort: undefined,
      });
    });
  });
});

/**
 * The keys the mutual-assignability parity guard structurally CANNOT enforce.
 *
 * `contract-parity.workflows.test.ts` compares the server's `WorkflowStepDef` with the contract's
 * by assigning each to the other. An **optional** property present on only one side stays
 * assignable in both directions, so a server-only key typechecks green and the guard says nothing
 * — the hazard the contract's own `heavy` docblock spells out. `GET /workflows` serves the
 * server's `WorkflowDef` verbatim, so such a key is already on the wire under a name the contract
 * does not know, and the first consumer to rebuild a step field-by-field drops it on the way back
 * through `POST /workflows`.
 *
 * For `byRunner` that is not theoretical: `spec-to-deploy` carries a codex model and effort on six
 * of its eight steps, so a round-trip through a contract type missing the key saves the built-in
 * workflow back with its whole codex policy gone.
 */
describe('contract mirrors the step keys the parity guard cannot see', () => {
  it('parses and PRESERVES effort and byRunner rather than stripping them', () => {
    const parsed = contractWorkflowStepDefSchema.parse({
      id: 'implement',
      prompt: '{{task}}',
      model: 'sonnet',
      effort: 'max',
      byRunner: { codex: { model: 'gpt-5.6-luna', effort: 'xhigh' } },
    });
    // `toMatchObject`, and on the PARSE OUTPUT: a schema that does not declare a key strips it
    // silently rather than throwing, so asserting the input round-trips is the only way to tell
    // "the contract knows this key" from "the contract quietly discarded it".
    expect(parsed.effort).toBe('max');
    expect(parsed.byRunner).toEqual({ codex: { model: 'gpt-5.6-luna', effort: 'xhigh' } });
  });

  it('every codex pin in spec-to-deploy survives a contract round-trip', () => {
    for (const step of SPEC_TO_DEPLOY_WORKFLOW.steps) {
      if (!step.byRunner) continue;
      expect(contractWorkflowStepDefSchema.parse(step).byRunner, step.id).toEqual(step.byRunner);
    }
  });
});


/**
 * The classifier's half of the router (`.ai/specs/2026-08-24-auto-classify-task-model.md`).
 * `resolveStepModel`'s fifth parameter is the LAST resort: everything anybody named already wins,
 * and it fills a hole only when nothing at all was named.
 */
describe('auto task class (2026-08-24-auto-classify-task-model)', () => {
  const AUTO = { model: 'gpt-5.6-terra', effort: 'medium' } as const;
  const bare: WorkflowStepDef = { id: 'x', prompt: '{{task}}' };

  it('fills a step that names nothing, on codex', () => {
    expect(resolveStepModel(bare, 'codex', undefined, 0, AUTO)).toEqual(AUTO);
  });

  it('is ignored when a byRunner pair names the pair', () => {
    const step = SPEC_TO_DEPLOY_WORKFLOW.steps.find((s) => s.id === 'implement')!;
    expect(resolveStepModel(step, 'codex', undefined, 0, AUTO)).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'xhigh',
    });
  });

  it('is ignored when the step names a model', () => {
    const pinned: WorkflowStepDef = { id: 'x', prompt: '{{task}}', model: 'sonnet' };
    expect(resolveStepModel(pinned, 'codex', undefined, 0, AUTO)).toEqual({
      model: 'sonnet',
      effort: undefined,
    });
  });

  it('is ignored when the run names a model — the composer picker wins over the classifier', () => {
    expect(resolveStepModel(bare, 'codex', 'gpt-5.6-sol', 0, AUTO)).toEqual({
      model: 'gpt-5.6-sol',
      effort: undefined,
    });
  });

  it('is ignored when the step names ONLY an effort — a ceiling is a source, not a hole', () => {
    // The mixed-source case. A step with an effort and no model is not unpinned: filling it would
    // replace a deliberate ceiling with a different pair, which is the same half-applied-override
    // failure the `byRunner` "both halves or neither" rule exists to prevent.
    const ceiling: WorkflowStepDef = { id: 'x', prompt: '{{task}}', effort: 'low' };
    expect(resolveStepModel(ceiling, 'codex', undefined, 0, AUTO)).toEqual({
      model: undefined,
      effort: 'low',
    });
  });

  it('supplies BOTH halves or neither — it never lends its effort to another layer\'s model', () => {
    const pinned: WorkflowStepDef = { id: 'x', prompt: '{{task}}', model: 'sonnet' };
    const resolved = resolveStepModel(pinned, 'codex', undefined, 0, AUTO);
    expect(resolved.effort, 'the auto effort must not ride along with a pinned model').toBeUndefined();
  });

  it('resolves to nothing when there is no auto choice — today\'s behaviour, unchanged', () => {
    // The negative control on all of the above: without it, every assertion here passes equally
    // well for a resolver that returns the auto pair unconditionally.
    expect(resolveStepModel(bare, 'codex')).toEqual({ model: undefined, effort: undefined });
    expect(resolveStepModel(bare, 'claude')).toEqual({ model: undefined, effort: undefined });
  });

  it('composes with the escalation ladder: an auto explore climbs, an auto tiny does not', () => {
    // `explore` is terra/medium, which `escalatable()` recognises...
    expect(resolveStepModel(bare, 'codex', undefined, 1, CODEX_CLASS_CHOICE.explore)).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(resolveStepModel(bare, 'codex', undefined, 2, CODEX_CLASS_CHOICE.explore)).toEqual({
      model: 'gpt-5.6-sol',
      effort: 'max',
    });
    // ...and `tiny` is luna/medium, which it deliberately does not. A failing tiny task must not
    // end up on the most expensive model in the catalog.
    expect(resolveStepModel(bare, 'codex', undefined, 2, CODEX_CLASS_CHOICE.tiny)).toEqual(
      CODEX_CLASS_CHOICE.tiny,
    );
  });

  it('maps every class to a distinct codex pair, and only to 5.6 models', () => {
    const pairs = TASK_CLASSES.map((c) => `${CODEX_CLASS_CHOICE[c].model}:${CODEX_CLASS_CHOICE[c].effort}`);
    expect(new Set(pairs).size, `two classes share a pair: ${pairs.join(', ')}`).toBe(TASK_CLASSES.length);
    for (const c of TASK_CLASSES) {
      expect(CODEX_CLASS_CHOICE[c].model, c).toMatch(/^gpt-5\.6-(luna|terra|sol)$/);
      expect(CODEX_CLASS_CHOICE[c].effort, c).toBeDefined();
    }
  });

  it('the Claude table uses only shipped claude presets, and keeps the table\'s ORDER', async () => {
    // Grounded, not invented: `opus` is the owner's "spec + review by opus always" tier, `sonnet`
    // the "the rest ... claude sonnet" tier, `haiku` cezar's own cheap alias. All three must be
    // real presets or the pin is dropped at dispatch exactly as the dead codex ids were.
    for (const c of TASK_CLASSES) {
      expect(KNOWN_PRESETS_BY_RUNNER.claude, c).toContain(CLAUDE_CLASS_CHOICE[c].model);
    }
    expect(CLAUDE_CLASS_CHOICE.tiny.model).toBe('haiku');
    expect(CLAUDE_CLASS_CHOICE.complex.model).toBe('opus');
    // Claude has no tier between sonnet and opus, so effort is what separates the middle two rows.
    // Losing that would collapse `scoped` and `explore` into the same cell.
    expect(CLAUDE_CLASS_CHOICE.scoped.model).toBe(CLAUDE_CLASS_CHOICE.explore.model);
    expect(CLAUDE_CLASS_CHOICE.scoped.effort).not.toBe(CLAUDE_CLASS_CHOICE.explore.effort);
  });

  it('every runner table covers every class, and no model conflicts with its own runner', () => {
    for (const [runner, table] of Object.entries(CLASS_CHOICE_BY_RUNNER)) {
      for (const c of TASK_CLASSES) {
        const choice = table![c];
        expect(choice, `${runner}.${c}`).toBeDefined();
        // The guard that killed the old codex presets: a table naming another runner's id would be
        // dropped at dispatch and the class would silently do nothing.
        expect(
          modelConflictsWithRunner(choice.model!, runner as RunnerId),
          `${runner}.${c} names ${choice.model}, which ${runner} cannot serve`,
        ).toBe(false);
      }
    }
  });

  it('opencode and pi have NO class table, so they classify nothing', () => {
    // The negative control on the runner map: without it, "codex and claude classify" is equally
    // provable by a map that classifies everything. Their models are discovered from the host, so a
    // literal table here would be one release from naming a model the user's provider lacks.
    expect(CLASS_CHOICE_BY_RUNNER.opencode).toBeUndefined();
    expect(CLASS_CHOICE_BY_RUNNER.pi).toBeUndefined();
    expect(Object.keys(CLASS_CHOICE_BY_RUNNER).sort()).toEqual(['claude', 'codex']);
  });

  it('the unclassifiable fallback is terra/medium — cheaper than sol AND on the escalation ladder', () => {
    // Asserted as the concrete pair, not merely "something non-null". The whole point of D3 is
    // that the fallback is a specific cell chosen for two properties: it is strictly better than
    // the `gpt-5.6-sol` + null-effort default it replaces, and it is one of the two rungs that
    // climb. A test that only checked "defined" would pass for a luna fallback with no ladder.
    expect(CODEX_CLASS_CHOICE[UNCLASSIFIABLE_TASK_CLASS]).toEqual({
      model: 'gpt-5.6-terra',
      effort: 'medium',
    });
    expect(
      resolveStepModel(bare, 'codex', undefined, 1, CODEX_CLASS_CHOICE[UNCLASSIFIABLE_TASK_CLASS]),
      'the fallback must be escalatable, or a failure has nowhere to climb',
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
  });
});

/**
 * `pinWorkflowRunner` / `spec-to-deploy-codex` (`.ai/specs/2026-08-24-codex-only-default-
 * workflow.md`, D1–D3). V1 pins the resolved model/effort of every step of the derived workflow
 * to the D3 table; V2 pins the derivation itself as an identity, not merely "looks similar", so a
 * future change that turns `pinWorkflowRunner` into a copy rather than a pure `runner` rewrite
 * fails loudly here.
 */
describe('pinWorkflowRunner / spec-to-deploy-codex (V1, V2)', () => {
  const CODEX_ONLY_WORKFLOW = pinWorkflowRunner(SPEC_TO_DEPLOY_WORKFLOW, 'codex', {
    name: SPEC_TO_DEPLOY_CODEX_NAME,
    description: 'The default chain with every agent step pinned to codex.',
  });

  it('names the derived workflow spec-to-deploy-codex, via the shared suffix constant', () => {
    expect(CODEX_ONLY_WORKFLOW_SUFFIX).toBe('-codex');
    expect(SPEC_TO_DEPLOY_CODEX_NAME).toBe('spec-to-deploy-codex');
    expect(CODEX_ONLY_WORKFLOW.name).toBe(SPEC_TO_DEPLOY_CODEX_NAME);
  });

  it('V1 — every step resolves the D3 table on codex, and spec never resolves to opus', () => {
    const byId = Object.fromEntries(CODEX_ONLY_WORKFLOW.steps.map((s) => [s.id, s]));
    const expected: Record<string, { model: string; effort: string | undefined }> = {
      context: { model: 'gpt-5.6-terra', effort: 'medium' },
      spec: { model: 'gpt-5.6-sol', effort: 'medium' },
      'review-spec-local': { model: 'gpt-5.6-sol', effort: 'high' },
      'review-spec': { model: 'gpt-5.6-sol', effort: 'high' },
      implement: { model: 'gpt-5.6-luna', effort: 'xhigh' },
      'run-tests': { model: 'gpt-5.6-luna', effort: 'medium' },
      'commit-push': { model: 'gpt-5.6-luna', effort: 'medium' },
      merge: { model: 'gpt-5.6-luna', effort: 'medium' },
      document: { model: 'gpt-5.6-luna', effort: 'high' },
      deploy: { model: 'gpt-5.6-luna', effort: 'medium' },
    };
    for (const [id, want] of Object.entries(expected)) {
      const step = byId[id];
      expect(step, id).toBeDefined();
      expect(resolveStepModel(step!, 'codex'), id).toEqual(want);
    }
    expect(resolveStepModel(byId.spec!, 'codex').model, 'spec must never resolve to opus on codex').not.toBe('opus');
  });

  it('V2 — same step ids as the base workflow, in the same order', () => {
    expect(CODEX_ONLY_WORKFLOW.steps.map((s) => s.id)).toEqual(SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => s.id));
  });

  it('V2 — every agent step is pinned to codex; no check step gains a runner it never had', () => {
    for (const step of CODEX_ONLY_WORKFLOW.steps) {
      if (stepKind(step) === 'agent') {
        expect(step.runner, step.id).toBe('codex');
      } else {
        expect(step.runner, step.id).toBeUndefined();
      }
    }
  });

  it('V2 — the identity: every derived step, with runner deleted, deep-equals the base step', () => {
    const baseById = Object.fromEntries(SPEC_TO_DEPLOY_WORKFLOW.steps.map((s) => [s.id, s]));
    for (const derived of CODEX_ONLY_WORKFLOW.steps) {
      const base = baseById[derived.id]!;
      const { runner: _derivedRunner, ...derivedRest } = derived;
      const { runner: _baseRunner, ...baseRest } = base;
      expect(derivedRest, derived.id).toEqual(baseRest);
    }
  });

  it('V2 — pinWorkflowRunner does not mutate its input: the base workflow is unchanged', () => {
    expect(SPEC_TO_DEPLOY_WORKFLOW.steps[1]?.id).toBe('spec');
    expect(SPEC_TO_DEPLOY_WORKFLOW.steps[1]?.runner).toBe('claude');
  });
});
