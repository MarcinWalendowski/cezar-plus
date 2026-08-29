import type { LockableRunner } from '@loki-labs/better-cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';

/** The outcome of consulting the global provider lock at one dispatch decision
 *  (`.ai/specs/2026-08-29-global-provider-toggle.md`, D4). */
export interface RunnerLockDecision {
  /** What actually runs. */
  runner: RunnerId;
  /** True only when the lock CHANGED the answer — the key the `run.runner_locked` metric and the
   *  UI note read. The lock agreeing with the request (it was already going to run there) is not
   *  an override and must not fire the metric. */
  locked: boolean;
  /** What would have run with no lock. Never omitted, so the record can always say what was
   *  overridden. */
  wouldHaveBeen: RunnerId;
}

/**
 * PURE. Applies the global provider lock to one dispatch-time request.
 *
 * `undefined` lock ⇒ identity: `{ runner: requested, locked: false, wouldHaveBeen: requested }`.
 * That identity is what makes "unset is byte-for-byte today's behaviour" a testable claim rather
 * than a hope — every one of D4's eight call sites wraps its existing expression in this function
 * rather than branching on whether a lock is set.
 *
 * Every site becomes `applyRunnerLock(lock, <today's expression>)`. `locked` is what the metric
 * keys on; nothing re-derives "did the lock bite?" from the inputs a second time.
 */
export function applyRunnerLock(
  lock: LockableRunner | undefined,
  requested: RunnerId,
): RunnerLockDecision {
  if (lock === undefined) return { runner: requested, locked: false, wouldHaveBeen: requested };
  return { runner: lock, locked: lock !== requested, wouldHaveBeen: requested };
}
