import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRunResult, AgentRunSpec, AgentRunner } from './core/agent-runner.ts';
import { classifyTask } from './task-classifier.ts';
import { TASK_CLASSES, UNCLASSIFIABLE_TASK_CLASS } from './workflows/types.ts';

/**
 * `.ai/specs/2026-08-24-auto-classify-task-model.md` Verification 4-5.
 *
 * The stub is the same shape `notes/processor.test.ts` uses, and for the same reason: this module's
 * whole contract is what it does with a runner's answer, so a real runner would test the CLI and
 * not this file.
 */
function scriptedRunner(answers: string[]): { runner: AgentRunner; specs: AgentRunSpec[] } {
  const specs: AgentRunSpec[] = [];
  let call = 0;
  const runner = {
    backend: 'claude',
    async run(spec: AgentRunSpec): Promise<AgentRunResult> {
      specs.push(spec);
      const answer = answers[Math.min(call++, answers.length - 1)];
      if (answer === undefined || answer.startsWith('THROW:')) {
        throw new Error(answer?.slice(6) ?? 'runner unavailable');
      }
      return { text: answer } as AgentRunResult;
    },
    startSession() {
      throw new Error('not used by the classifier');
    },
    async interrupt() {},
  } as unknown as AgentRunner;
  return { runner, specs };
}

describe('classifyTask', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let root: string;

  beforeAll(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-classify-home-'));
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-classify-root-'));
    process.env.CEZ_HOME = home;
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  afterEach(() => {
    // nothing persistent — the classifier writes no state at all, which is itself the property
    // that lets these cases share one temp root.
  });

  const run = (answers: string[], task = 'rename the button') => {
    const { runner, specs } = scriptedRunner(answers);
    return { promise: classifyTask(root, task, { runnerFactory: () => runner }), specs };
  };

  it.each(TASK_CLASSES)('round-trips the "%s" class', async (taskClass) => {
    const { promise } = run([JSON.stringify({ class: taskClass, why: 'because' })]);
    await expect(promise).resolves.toEqual({ taskClass, classified: true, reason: 'because' });
  });

  it('reads the class out of prose around the JSON', async () => {
    const { promise } = run(['Here you go:\n```json\n{"class":"complex"}\n```\nHope that helps.']);
    const result = await promise;
    expect(result.taskClass).toBe('complex');
    expect(result.classified).toBe(true);
  });

  it('retries ONCE on an unparseable answer, then falls back', async () => {
    const { promise, specs } = run(['not json at all', 'still not json']);
    const result = await promise;
    expect(specs, 'an unparseable answer is worth exactly one more try').toHaveLength(2);
    expect(result).toEqual({
      taskClass: UNCLASSIFIABLE_TASK_CLASS,
      classified: false,
      reason: 'the runner answered nothing this pass could parse',
    });
  });

  it('accepts the SECOND answer when the first was unparseable', async () => {
    // The negative control on the retry: without it, "retries once" is equally provable by a
    // classifier that ignores the second answer and falls back regardless.
    const { promise } = run(['garbage', JSON.stringify({ class: 'tiny' })]);
    await expect(promise).resolves.toMatchObject({ taskClass: 'tiny', classified: true });
  });

  it('does NOT retry a runner error, and reports it', async () => {
    const { promise, specs } = run(['THROW:codex is not authenticated']);
    const result = await promise;
    expect(specs, 'a runner that is down is not a condition a second identical call improves').toHaveLength(1);
    expect(result).toEqual({
      taskClass: UNCLASSIFIABLE_TASK_CLASS,
      classified: false,
      reason: 'codex is not authenticated',
    });
  });

  it('rejects a class the enum does not name rather than passing it through', async () => {
    const { promise } = run([JSON.stringify({ class: 'trivial' }), JSON.stringify({ class: 'trivial' })]);
    await expect(promise).resolves.toMatchObject({ classified: false });
  });

  it('answers the fallback for an empty task without calling the runner at all', async () => {
    const { runner, specs } = scriptedRunner([JSON.stringify({ class: 'complex' })]);
    const result = await classifyTask(root, '   \n  ', { runnerFactory: () => runner });
    expect(specs).toHaveLength(0);
    expect(result).toEqual({
      taskClass: UNCLASSIFIABLE_TASK_CLASS,
      classified: false,
      reason: 'the task is empty',
    });
  });

  it('sends no tools, a bounded timeout, and the dry-run marker', async () => {
    const { promise, specs } = run([JSON.stringify({ class: 'scoped' })], 'migrate the auth tables');
    await promise;
    const spec = specs[0]!;
    expect(spec.allowedTools, 'the task text is untrusted input; a shell here is the whole blast radius').toEqual([]);
    expect(spec.timeoutMs).toBe(30_000);
    expect(spec.userPrompt).toContain('[cez-classify]');
    expect(spec.userPrompt).toContain('migrate the auth tables');
  });

  it('shows the classifier a bounded excerpt, and says when it truncated', async () => {
    // A task body is unbounded (a pasted stack trace, a whole spec). The prefix is the right half
    // here — a task opens by saying what to do — but the truncation is marked so the model is not
    // asked to classify a document that appears to stop mid-word for no reason.
    const huge = `fix the login bug. ${'x'.repeat(10_000)}`;
    const { runner, specs } = scriptedRunner([JSON.stringify({ class: 'scoped' })]);
    await classifyTask(root, huge, { runnerFactory: () => runner });
    const prompt = specs[0]!.userPrompt;
    expect(prompt.length, 'the whole 10k body must not reach the cheap call').toBeLessThan(4_500);
    expect(prompt, 'the opening sentence is the half that decides the class').toContain('fix the login bug.');
    expect(prompt).toContain('(truncated');
  });

  it('does NOT claim truncation for a task that fits', async () => {
    // The negative control: without it, "says when it truncated" passes for a classifier that
    // appends the marker unconditionally.
    const { promise, specs } = run([JSON.stringify({ class: 'tiny' })], 'rename a variable');
    await promise;
    expect(specs[0]!.userPrompt).not.toContain('(truncated');
  });

  it('offers the model every class it will accept', async () => {
    // The prompt and the schema are both built from TASK_CLASSES. This is what makes that
    // load-bearing: a class the schema accepts but the prompt never mentions is one the model
    // can only reach by accident.
    const { promise, specs } = run([JSON.stringify({ class: 'scoped' })]);
    await promise;
    for (const c of TASK_CLASSES) expect(specs[0]!.systemPrompt, c).toContain(`"${c}"`);
  });
});
