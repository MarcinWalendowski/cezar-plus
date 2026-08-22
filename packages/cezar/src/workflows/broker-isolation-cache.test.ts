import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { probeIsolationCapabilities } from '../core/broker-isolation.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

/**
 * `RunManager.brokerIsolation()` (Phase 0.3, `.ai/specs/2026-08-22-broker-scope-isolation-full-stop-survival.md`).
 *
 * Before this fix, a non-`'scope'` result was cached unconditionally for the process's whole
 * lifetime (`this.brokerIsolationCache ??= ...`) — so a boot where `cezar.service` starts before
 * `user@<uid>.service` has finished pinned the run broker to a degraded isolation mode forever,
 * with nothing logged. This file locks in the corrected behavior: re-probe until `'scope'` is
 * observed, cache only `'scope'` (which cannot regress on its own), and warn once per distinct
 * degraded value rather than once per call — `brokerIsolation()` is consulted on every health/ready
 * poll (`server.ts`'s `describeRuntime`), not only per run-start.
 */
vi.mock('../core/broker-isolation.ts', async (importActual) => {
  const actual = await importActual<typeof import('../core/broker-isolation.ts')>();
  return { ...actual, probeIsolationCapabilities: vi.fn() };
});

const probe = vi.mocked(probeIsolationCapabilities);

describe('RunManager.brokerIsolation() — re-probe until scope, then cache', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-broker-isolation-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    probe.mockReset();
  });

  afterEach(() => {
    manager?.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    warn.mockRestore();
  });

  it('re-probes on every call while the result stays non-scope, rather than locking it in', () => {
    probe.mockReturnValue({ userScopeAvailable: false, delegated: true });

    expect(manager.brokerIsolation()).toBe('delegated');
    expect(manager.brokerIsolation()).toBe('delegated');
    expect(manager.brokerIsolation()).toBe('delegated');

    // The bug this fix closes: the old `??=` caching would have probed exactly once.
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('recovers automatically once the underlying capability appears — the actual race being closed', () => {
    // Models a boot where cezar.service starts before user@<uid>.service has finished: the first
    // few calls see no user manager yet, then it comes up.
    probe
      .mockReturnValueOnce({ userScopeAvailable: false, delegated: true })
      .mockReturnValueOnce({ userScopeAvailable: false, delegated: true })
      .mockReturnValue({ userScopeAvailable: true, delegated: true });

    expect(manager.brokerIsolation()).toBe('delegated');
    expect(manager.brokerIsolation()).toBe('delegated');
    expect(manager.brokerIsolation()).toBe('scope');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('stops probing once scope is observed — the one result that cannot regress on its own', () => {
    probe.mockReturnValue({ userScopeAvailable: true, delegated: true });

    expect(manager.brokerIsolation()).toBe('scope');
    expect(manager.brokerIsolation()).toBe('scope');
    expect(manager.brokerIsolation()).toBe('scope');

    // Once cached as 'scope', later calls must not re-probe at all.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('warns once for a degraded result, not once per call', () => {
    probe.mockReturnValue({ userScopeAvailable: false, delegated: true });

    manager.brokerIsolation();
    manager.brokerIsolation();
    manager.brokerIsolation();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('delegated');
  });

  it('warns again if the degraded value changes, and never warns once scope is reached', () => {
    probe
      .mockReturnValueOnce({ userScopeAvailable: false, delegated: false })
      .mockReturnValueOnce({ userScopeAvailable: false, delegated: false })
      .mockReturnValueOnce({ userScopeAvailable: false, delegated: true })
      .mockReturnValue({ userScopeAvailable: true, delegated: true });

    expect(manager.brokerIsolation()).toBe('none');
    expect(manager.brokerIsolation()).toBe('none');
    expect(manager.brokerIsolation()).toBe('delegated');
    expect(manager.brokerIsolation()).toBe('scope');
    expect(manager.brokerIsolation()).toBe('scope');

    // One warning for 'none', one for the transition to 'delegated', none for 'scope'.
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('emits no warning at all when the very first probe already returns scope', () => {
    probe.mockReturnValue({ userScopeAvailable: true, delegated: true });
    manager.brokerIsolation();
    expect(warn).not.toHaveBeenCalled();
  });
});
