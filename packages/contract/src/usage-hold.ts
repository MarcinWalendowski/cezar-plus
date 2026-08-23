import { DEFAULT_AGENT_ACCOUNT_ID } from './agent-profiles.ts';
import type { ProviderId } from './workspace.ts';

/**
 * Which agent ACCOUNT a piece of work belongs to, and which account a usage limit actually closed
 * (spec `2026-08-23-usage-limit-hold-account.md`).
 *
 * These three functions live in the contract package rather than beside the queue for one reason:
 * the ENGINE decides what is held and the COCKPIT has to explain it, and a queue that refuses to
 * start a task while the UI cannot say why is the failure this spec was filed for. Two spellings
 * of "which account is this" would drift the moment either side changed, and the drift would be
 * invisible — a hold keyed one way and rendered another simply stops matching, with no error.
 *
 * ## The distinction that matters: where the work WILL run vs where it WAS refused
 *
 * `runAccountKey` answers the first — a queued run has no started step, so the only honest answer
 * is the backend and account it is configured to take. `usageHoldAccountKey` answers the second,
 * and it must read the STEP, because a run's steps do not all run on the run's own backend: a
 * workflow step may pin its own `runner` (the built-in `spec-to-deploy` pins `spec` and
 * `review-spec` to claude), and the account pool may route two steps of one run to two different
 * logins.
 *
 * Measured on `prod-host`, 2026-08-23, which is why this file exists: run `76680e19` carried
 * `runner: codex` / `agentProfile: default` at the run level while its `review-spec` step ran on
 * `claude` / `default` and came back "You've hit your weekly limit". Keying the hold off the run
 * put the limit on `codex:default`, so a genuinely unrelated codex task (`7c01e21d`) sat `queued`
 * for hours behind a Claude limit, and a real claude task would NOT have been held at all and
 * would have walked straight into the closed window. Both halves of the gate were wrong from one
 * wrong key.
 */

/**
 * The key every account-scoped number is stored under: **provider AND account id**, never the id
 * alone. Absent/empty account = the discovered default login, never a distinct account.
 *
 * The discovered account is the reserved id `"default"` for EVERY provider (see
 * `DEFAULT_AGENT_ACCOUNT_ID`), so `"default"` on its own names Claude's discovered login and
 * Codex's discovered login at the same time. Keying on it alone would pool two different
 * subscriptions into one bucket: their in-flight counts would add up, one's rate-limit would
 * exclude the other from routing, and Codex's quota bar would be drawn against a Claude row.
 *
 * Stored accounts have unique ids and would survive the shorter key, which is exactly what makes
 * this worth stating — the bug would only ever appear on the zero-config setup, the one most
 * people run.
 *
 * Lived in `packages/cezar/src/workspace/agent-account-usage.ts` until 2026-08-23; that module
 * re-exports it, so nothing in the service changed its import.
 */
export function accountUsageKey(provider: ProviderId, accountId?: string | null): string {
  return `${provider}:${accountId || DEFAULT_AGENT_ACCOUNT_ID}`;
}

/** The run-level fields every candidate key is built from. Structural on purpose — a `RunRecord`
 *  satisfies it, and so does a test fixture that does not want to build one. */
export interface AccountRunFields {
  runner?: ProviderId;
  agentProfile?: string;
}

/** The step fields that say which account actually served a step. */
export interface AccountStepFields {
  status?: string;
  backend?: ProviderId;
  profileId?: string;
}

/**
 * Where this run's work WILL run — the admission-side key.
 *
 * A run that names no runner has not started yet and will take the configured default, which is
 * what `fallbackRunner` carries. A run still carrying a `pool:` route names no account yet; the
 * pool string becomes its own key, which can only match another unresolved run on the same pool.
 * That is the conservative reading, and `execute()` overwrites `agentProfile` with the concrete
 * login before the run can hold anything.
 */
export function runAccountKey(run: AccountRunFields, fallbackRunner: ProviderId): string {
  return accountUsageKey(run.runner ?? fallbackRunner, run.agentProfile);
}

/**
 * Which account this run's usage limit actually closed — the hold-side key.
 *
 * Three tiers, most direct first:
 *
 *  1. **The newest FAILED step that names a backend.** This is the refusal itself: the provider
 *     said no to that backend on that login, and nothing else in the record is evidence about
 *     which window is shut.
 *  2. **The newest step that names a backend at all.** Covers the in-flight resume, where the
 *     step being retried is no longer `failed` — a resume continues the same session on the same
 *     backend, so the newest stamped step is still the account under test.
 *  3. **The run-level fields.** Only for a record whose steps carry no backend: everything written
 *     before backend affinity, and a run that failed before any step was stamped. This is the old
 *     behavior, kept as the floor rather than as the rule.
 *
 * `backend` is stamped when a step STARTS, not when it ends, so tier 1 covers every step that got
 * far enough to be refused by a provider.
 */
export function usageHoldAccountKey(
  run: AccountRunFields & { steps?: readonly AccountStepFields[] },
  fallbackRunner: ProviderId,
): string {
  const stamped = (run.steps ?? []).filter((step): step is AccountStepFields & { backend: ProviderId } =>
    Boolean(step.backend),
  );
  // A reverse scan rather than `findLast`: this package compiles against `lib: ES2022`, where
  // `Array.prototype.findLast` does not exist.
  let failed: (AccountStepFields & { backend: ProviderId }) | undefined;
  for (let i = stamped.length - 1; i >= 0; i -= 1) {
    if (stamped[i]!.status === 'failed') {
      failed = stamped[i];
      break;
    }
  }
  const step = failed ?? stamped.at(-1);
  if (step) return accountUsageKey(step.backend, step.profileId);
  return runAccountKey(run, fallbackRunner);
}
