import { useProviderStatus, useRunnerLock } from '@/api/queries'
import type { ApiRun, Runner } from '@loki-labs/better-cezar-api-client'
import { usableRunners } from '@/lib/provider-status'
import { effectiveLock, resolveRunner } from '@/routes/new-task-form'

/** One provider decision for every UI path that reopens an existing agent session. */
export function useContinuationProvider(run: ApiRun, pickedRunner: Runner | null = null) {
  const providers = useProviderStatus()
  const runners = usableRunners(providers.data)
  const currentRunner = (run.runner ?? 'claude') as Runner
  // The global engine lock (`.ai/specs/2026-08-29-global-provider-toggle.md`, D2 rank 4 / D6) beats
  // BOTH candidates here, and the second one is the point: a lock has to move a run that is already
  // in flight onto the locked provider at its next step, so a continuation that quietly reopened on
  // `run.runner` would be the one path where "for every workflow" stopped being true — and it is
  // the path a person uses most, because it is the one they press after setting the lock.
  const runnerLock = useRunnerLock()
  const lock = effectiveLock(runnerLock, runners)
  const runner = lock ?? resolveRunner(pickedRunner, runners, currentRunner)
  const currentRunnerConnected = runners.includes(currentRunner)
  const canContinue = providers.isSuccess && runners.length > 0
  const reason = providers.isPending
    ? 'Checking agent providers…'
    : providers.isError
      ? 'Provider authentication could not be verified.'
      : canContinue
        ? undefined
        : 'Connect an agent provider to continue.'

  return {
    runners,
    currentRunner,
    runner,
    /** The lock this host can honour, or `null`. Passed to `RunnerPill` as `lockedTo`. */
    lock,
    currentRunnerConnected,
    canContinue,
    providerPending: providers.isPending,
    providerError: providers.isError,
    reason,
    // Sent under a lock even when nothing was touched: omitting it means "keep `run.runner`", which
    // is the very thing the lock overrides, and it would leave the pill saying codex while the
    // request said nothing at all.
    runnerOverride:
      pickedRunner !== null || !currentRunnerConnected || lock !== null
        ? runner
        : undefined,
  }
}
