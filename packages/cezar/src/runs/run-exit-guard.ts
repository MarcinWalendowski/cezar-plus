import type { RunRecord, RunStatus } from '@loki-labs/better-cezar-contract';

export const RUN_KEEPALIVE_MS = 1_000;
export const RUN_WEDGE_TICKS = 3;

const TERMINAL_STATUSES = new Set<RunStatus>(['done', 'review', 'failed', 'cancelled']);

export interface RunExitGuardStore {
  getRun(runId: string): RunRecord | undefined;
  updateRun(
    runId: string,
    patch: Partial<Omit<RunRecord, 'id' | 'steps'>>,
  ): RunRecord | undefined;
  flush(): void;
}

export interface RunExitGuardState {
  handled: boolean;
}

export interface RunWedgeState {
  misses: number;
}

function exitError(status: RunStatus, reason?: string): string {
  const detail = reason ? `: ${reason}` : '';
  return `cezar exited before the run finished: the process ran out of work while the run was still ${status}${detail}`;
}

function failNonTerminalRun(
  store: RunExitGuardStore,
  runId: string,
  status: RunStatus,
  reason?: string,
): void {
  const error = exitError(status, reason);
  store.updateRun(runId, {
    status: 'failed',
    error,
    finishedAt: new Date().toISOString(),
  });
  store.flush();
  console.error(error);
  process.exitCode = 1;
}

/** Backstop for an empty event loop while a headless run is still non-terminal. */
export function runExitGuard(
  store: RunExitGuardStore,
  runId: string,
  state: RunExitGuardState,
): void {
  if (state.handled) return;
  state.handled = true;
  const record = store.getRun(runId);
  if (!record || TERMINAL_STATUSES.has(record.status)) return;
  failNonTerminalRun(store, runId, record.status);
}

/**
 * One keep-alive tick for a headless run. The wider liveness predicate is deliberately distinct
 * from RunManager.isActive(), which answers whether an HTTP mutation is currently allowed.
 */
export function runWedgeTick(options: {
  store: RunExitGuardStore;
  runId: string;
  state: RunWedgeState;
  liveness: () => { live: boolean; reason: string };
  settle: (status: RunStatus) => void;
  clearKeepAlive: () => void;
}): void {
  const record = options.store.getRun(options.runId);
  if (!record) return;

  if (TERMINAL_STATUSES.has(record.status)) {
    options.settle(record.status);
    options.clearKeepAlive();
    return;
  }

  const liveness = options.liveness();
  if (liveness.live) {
    options.state.misses = 0;
    return;
  }

  options.state.misses += 1;
  if (options.state.misses < RUN_WEDGE_TICKS) return;

  failNonTerminalRun(options.store, options.runId, record.status, liveness.reason);
  options.settle('failed');
  options.clearKeepAlive();
}
