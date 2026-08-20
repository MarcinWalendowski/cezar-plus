import type { RunRecord, StepState } from './store.ts';

/**
 * Invariant I1 — only the chain finishes the run
 * (spec `.ai/specs/2026-08-20-chain-integrity-restart-and-continuation.md`).
 *
 * A run's workflow is a CHAIN of steps; a session is one step of it. Three completion
 * paths used to settle a run from a session-level signal — a restart settle, a
 * continuation's `CEZ:DONE`, `settleSuccess` itself — without ever asking whether the
 * chain was finished. That is how run `be31d9e9` was marked `done` after step 1 of 6,
 * applying twelve workspace worktrees back and closing the task with `implement`,
 * `run-tests`, `commit-push`, `document` and `deploy` never run.
 *
 * This predicate is the question those paths now ask, and it is deliberately the only
 * new machinery: pure, no manager dependency, one meaning of "the chain still has work".
 */

/** Step statuses that mean the chain has finished with this step, for good or ill. */
const TERMINAL: ReadonlySet<StepState['status']> = new Set(['done', 'failed', 'cancelled', 'skipped']);

/** `true` when the chain is finished with this step. An absent record (the step was never
 *  reached) is NOT terminal — that is the whole point of the predicate. */
export function stepTerminal(status: StepState['status'] | undefined): boolean {
  return status !== undefined && TERMINAL.has(status);
}

/**
 * Does this definition actually describe THIS run?
 *
 * `reviveWorkflow` falls back to the CATALOG by name when a record carries no `workflowDef`,
 * and a catalog workflow's step ids need not match the ids the record was created with — the
 * built-in `quick-task` names its step `task`, while older records name theirs `work`. Against
 * such a def every step looks "never reached", so a re-entry would re-run work that is already
 * done: strictly worse than the bug the chain guard exists to fix.
 *
 * The test is one-directional on purpose: every real (non-synthetic) step ON THE RECORD must
 * exist in the definition. A def may legitimately contain steps the record has not reached yet;
 * it may not be missing a step the run has already executed.
 */
export function defDescribesRun(
  steps: readonly { id: string }[],
  records: readonly StepState[],
): boolean {
  const ids = new Set(steps.map((s) => s.id));
  return records.every((r) => r.id.startsWith('continue-') || ids.has(r.id));
}

/**
 * Index of the first definition step the chain has not finished with — where a re-entry
 * picks back up (spec 2026-08-20, P1/P2). `-1` when every step is terminal.
 *
 * Takes the definition's steps and the record's steps rather than a `RunRecord`, because
 * recovery may revive a definition from the CATALOG when the record carries none, and the
 * resume point has to be computable in that case too.
 */
export function firstUnfinishedStep(
  steps: readonly { id: string }[],
  records: readonly StepState[],
): number {
  const byId = new Map(records.map((s) => [s.id, s]));
  return steps.findIndex((s) => !stepTerminal(byId.get(s.id)?.status));
}

/**
 * Step ids from the run's persisted workflow DEFINITION that have not reached a terminal
 * state, in definition order.
 *
 * - `pending`, `running`, `waiting` and `review` are non-terminal, as is a def step with no
 *   record at all (never reached). `done`/`failed`/`cancelled`/`skipped` are terminal — a
 *   step that failed already stopped the chain through `runError` and must not re-open it.
 * - Synthetic `continue-N` steps are NOT part of the definition, so they are never returned:
 *   a continuation is a session on top of a chain, never a member of it.
 *
 * Fail-open by design: a record with no `workflowDef` — pre-#367 records, or a def the store
 * `.catch`ed to `undefined` because it no longer fits the schema — returns `[]`, so those runs
 * settle exactly as they do today rather than parking forever. AGENTS.md § "A fail-open helper
 * needs a populated-input guarantee": all live records carry the def (persisted at run start),
 * and the empty/absent-input case is pinned by its own test rather than left implicit.
 */
export function pendingChainSteps(run: RunRecord): string[] {
  const def = run.workflowDef;
  if (!def?.steps?.length) return [];
  const byId = new Map(run.steps.map((s) => [s.id, s]));
  return def.steps.filter((s) => !stepTerminal(byId.get(s.id)?.status)).map((s) => s.id);
}
