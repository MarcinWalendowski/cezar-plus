import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunRecord, RunStatus } from '@loki-labs/cezar-plus-contract';
import {
  RUN_WEDGE_TICKS,
  runExitGuard,
  runWedgeTick,
  type RunExitGuardStore,
} from './run-exit-guard.ts';

function record(status: RunStatus): RunRecord {
  return {
    id: 'run-1',
    title: 'test',
    workflow: 'quick-task',
    task: 'test',
    status,
    createdAt: new Date(0).toISOString(),
    tokensUsed: 0,
    archived: false,
    steps: [],
  };
}

function fixture(status: RunStatus): {
  store: RunExitGuardStore;
  current: () => RunRecord;
  updateRun: ReturnType<typeof vi.fn>;
  flush: ReturnType<typeof vi.fn>;
} {
  let current = record(status);
  const updateRun = vi.fn((_runId: string, patch: Partial<RunRecord>) => {
    current = { ...current, ...patch };
    return current;
  });
  const flush = vi.fn();
  return {
    store: { getRun: () => current, updateRun, flush },
    current: () => current,
    updateRun,
    flush,
  };
}

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('runExitGuard', () => {
  it('does nothing for a terminal record', () => {
    const { store, updateRun } = fixture('done');
    process.exitCode = undefined;
    runExitGuard(store, 'run-1', { handled: false });
    expect(updateRun).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('fails a non-terminal record once and exits non-zero', () => {
    const { store, current, updateRun, flush } = fixture('running');
    const state = { handled: false };
    vi.spyOn(console, 'error').mockImplementation(() => {});

    runExitGuard(store, 'run-1', state);
    runExitGuard(store, 'run-1', state);

    expect(current()).toMatchObject({ status: 'failed' });
    expect(current().error).toContain('cezar-plus exited before the run finished');
    expect(updateRun).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});

describe('runWedgeTick', () => {
  it('requires three consecutive misses before failing the record', () => {
    const { store, current } = fixture('running');
    const state = { misses: 0 };
    const settle = vi.fn();
    const clearKeepAlive = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    for (let tick = 1; tick <= RUN_WEDGE_TICKS; tick += 1) {
      runWedgeTick({
        store,
        runId: 'run-1',
        state,
        liveness: () => ({ live: false, reason: 'not registered' }),
        settle,
        clearKeepAlive,
      });
      if (tick < RUN_WEDGE_TICKS) expect(current().status).toBe('running');
    }

    expect(current()).toMatchObject({ status: 'failed' });
    expect(settle).toHaveBeenCalledWith('failed');
    expect(clearKeepAlive).toHaveBeenCalledOnce();
  });

  it.each<RunStatus>(['done', 'failed'])('settles terminal %s records and clears the keep-alive', (status) => {
    const { store, updateRun } = fixture(status);
    const settle = vi.fn();
    const clearKeepAlive = vi.fn();

    // A missed store event must not leave the ref'd interval alive forever. Settling and
    // clearing lets the CLI finish with the existing status-derived exit code.
    runWedgeTick({
      store,
      runId: 'run-1',
      state: { misses: 0 },
      liveness: () => ({ live: false, reason: 'irrelevant' }),
      settle,
      clearKeepAlive,
    });

    expect(settle).toHaveBeenCalledWith(status);
    expect(clearKeepAlive).toHaveBeenCalledOnce();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it('settles failed after three missing-record ticks without trying to write a row', () => {
    const updateRun = vi.fn();
    const settle = vi.fn();
    const clearKeepAlive = vi.fn();
    const state = { misses: 0 };
    const store: RunExitGuardStore = {
      getRun: () => undefined,
      updateRun,
      flush: vi.fn(),
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;

    for (let tick = 0; tick < RUN_WEDGE_TICKS; tick += 1) {
      runWedgeTick({
        store,
        runId: 'missing-run',
        state,
        liveness: () => ({ live: false, reason: 'irrelevant' }),
        settle,
        clearKeepAlive,
      });
    }

    expect(updateRun).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith('failed');
    expect(clearKeepAlive).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      'cezar-plus exited before the run finished: its run record is missing from the store (missing-run)',
    );
  });

  it('resets consecutive misses after a live tick', () => {
    const { store, updateRun } = fixture('running');
    const state = { misses: 0 };
    const settle = vi.fn();
    const clearKeepAlive = vi.fn();
    const tick = (live: boolean): void => runWedgeTick({
      store,
      runId: 'run-1',
      state,
      liveness: () => ({ live, reason: live ? 'active' : 'not registered' }),
      settle,
      clearKeepAlive,
    });

    tick(false);
    tick(false);
    tick(true);
    tick(false);
    tick(false);

    expect(state.misses).toBe(2);
    expect(updateRun).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(clearKeepAlive).not.toHaveBeenCalled();
  });
});
