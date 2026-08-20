import { describe, expect, it } from 'vitest';
import { defDescribesRun, firstUnfinishedStep, pendingChainSteps, stepTerminal } from './chain.ts';
import type { RunRecord, StepState } from './store.ts';

/**
 * Invariant I1's predicate (spec 2026-08-20-chain-integrity-restart-and-continuation).
 * Pure — no store, no manager. The fixture is the recorded incident: run
 * `be31d9e9`, a six-step `spec-to-deploy` chain that was marked `done` after step 1
 * because nothing ever asked whether the chain was finished.
 */

const CHAIN_IDS = ['spec', 'implement', 'run-tests', 'commit-push', 'document', 'deploy'];

const def = (ids: string[] = CHAIN_IDS) => ({
  name: 'spec-to-deploy',
  source: 'built-in' as const,
  steps: ids.map((id) => ({ id, name: id, prompt: '{{task}}' })),
});

const step = (id: string, status: StepState['status']): StepState =>
  ({ id, name: id, kind: 'agent', status, iterations: 1, tokensUsed: 0 }) as StepState;

const record = (over: Partial<RunRecord>): RunRecord =>
  ({
    id: 'r1',
    title: 't',
    workflow: 'spec-to-deploy',
    task: 'do it',
    status: 'running',
    createdAt: '2026-08-20T09:58:00.000Z',
    steps: [],
    ...over,
  }) as RunRecord;

describe('pendingChainSteps', () => {
  it('returns the five steps that never ran (the be31d9e9 incident)', () => {
    const run = record({
      workflowDef: def(),
      steps: [
        step('spec', 'done'),
        ...CHAIN_IDS.slice(1).map((id) => step(id, 'pending')),
        step('continue-1', 'done'),
      ],
    });
    expect(pendingChainSteps(run)).toEqual(['implement', 'run-tests', 'commit-push', 'document', 'deploy']);
  });

  it('returns [] once every definition step is terminal', () => {
    const run = record({ workflowDef: def(), steps: CHAIN_IDS.map((id) => step(id, 'done')) });
    expect(pendingChainSteps(run)).toEqual([]);
  });

  it('treats failed / cancelled / skipped as terminal — a failed step must not re-open the chain', () => {
    const run = record({
      workflowDef: def(['a', 'b', 'c']),
      steps: [step('a', 'done'), step('b', 'failed'), step('c', 'skipped')],
    });
    expect(pendingChainSteps(run)).toEqual([]);
  });

  it('treats running / waiting / review and an absent record as NOT terminal', () => {
    const run = record({
      workflowDef: def(['a', 'b', 'c', 'd']),
      steps: [step('a', 'running'), step('b', 'waiting'), step('c', 'review')],
    });
    expect(pendingChainSteps(run)).toEqual(['a', 'b', 'c', 'd']);
  });

  // The fail-open pin (spec § Decisions / R1): a record whose `workflowDef` is absent — pre-#367,
  // or a def the store `.catch`ed to `undefined` — settles exactly as it does today rather than
  // parking forever. AGENTS.md § "A fail-open helper needs a populated-input guarantee".
  it('returns [] when the record carries no workflowDef (fail open)', () => {
    const run = record({ steps: [step('spec', 'done'), step('implement', 'pending')] });
    expect(pendingChainSteps(run)).toEqual([]);
  });

  it('returns [] for a definition with an empty step list', () => {
    const run = record({ workflowDef: { ...def(), steps: [] }, steps: [step('x', 'pending')] });
    expect(pendingChainSteps(run)).toEqual([]);
  });

  // A continuation is a session ON a chain, never a member of it.
  it('never returns a synthetic continue-N step, even while it is pending', () => {
    const run = record({
      workflowDef: def(['work']),
      steps: [step('work', 'done'), step('continue-1', 'pending'), step('continue-2', 'running')],
    });
    expect(pendingChainSteps(run)).toEqual([]);
  });

  it('is [] for a single-step quick-task that finished (the no-regression pin)', () => {
    const run = record({
      workflow: 'quick-task',
      workflowDef: { name: 'quick-task', source: 'built-in', steps: [{ id: 'work', name: 'Work' }] },
      steps: [step('work', 'done')],
    });
    expect(pendingChainSteps(run)).toEqual([]);
  });
});

describe('stepTerminal', () => {
  it('is false for an absent record — a step never reached is not a step finished', () => {
    expect(stepTerminal(undefined)).toBe(false);
  });

  it('maps every StepStatus the way the chain reads it', () => {
    expect(['done', 'failed', 'cancelled', 'skipped'].map((s) => stepTerminal(s as StepState['status']))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(['pending', 'running', 'waiting', 'review'].map((s) => stepTerminal(s as StepState['status']))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('firstUnfinishedStep', () => {
  it('is the index a chain re-entry resumes at', () => {
    const steps = CHAIN_IDS.map((id) => ({ id }));
    expect(firstUnfinishedStep(steps, [step('spec', 'running')])).toBe(0);
    expect(firstUnfinishedStep(steps, [step('spec', 'done')])).toBe(1);
    expect(firstUnfinishedStep(steps, CHAIN_IDS.map((id) => step(id, 'done')))).toBe(-1);
  });

  it('works against a catalog-revived definition the record has no entries for', () => {
    expect(firstUnfinishedStep([{ id: 'a' }, { id: 'b' }], [])).toBe(0);
  });
});

/**
 * `reviveWorkflow` falls back to the CATALOG by name when a record has no `workflowDef`, and a
 * catalog def's step ids need not match the ids the record was created with — the built-in
 * `quick-task` names its step `task`, older records name theirs `work`. Against such a def every
 * step reads as "never reached", so a chain re-entry would re-run work that is already done:
 * strictly worse than the bug the chain guard exists to fix. Caught by
 * `recover-pending-ask.test.ts` on the merged tree, pinned here at the source.
 */
describe('defDescribesRun', () => {
  const rec = (id: string, status: StepState['status'] = 'done'): StepState =>
    ({ id, name: id, kind: 'agent', status, iterations: 1, tokensUsed: 0 }) as StepState;

  it('rejects a catalog def whose ids do not match the record (quick-task `task` vs `work`)', () => {
    expect(defDescribesRun([{ id: 'task' }], [rec('work')])).toBe(false);
  });

  it('accepts the def the record was created from', () => {
    expect(defDescribesRun([{ id: 'work' }], [rec('work')])).toBe(true);
  });

  it('accepts a def with steps the run has not reached yet — the test is one-directional', () => {
    expect(defDescribesRun([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [rec('a')])).toBe(true);
  });

  it('ignores synthetic continue-N steps, which are never in any definition', () => {
    expect(defDescribesRun([{ id: 'a' }], [rec('a'), rec('continue-1'), rec('continue-2')])).toBe(true);
  });

  it('rejects when the record holds a step the definition has never heard of', () => {
    expect(defDescribesRun([{ id: 'a' }], [rec('a'), rec('legacy-step')])).toBe(false);
  });
});
