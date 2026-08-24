import { describe, expect, it } from 'vitest';

import {
  BROKER_ISOLATIONS,
  RUNS_SLICE,
  brokerScopeUnitName,
  buildBrokerLaunchArgv,
  buildRunScopeProperties,
  buildRunsSliceProperties,
  chooseIsolation,
  describeIsolation,
  detectResourceKill,
  survivesRestart,
  defaultRuntimeDir,
  probeUserScope,
  userScopeEnv,
} from './broker-isolation.ts';

/** P4 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`. */

describe('chooseIsolation', () => {
  it('prefers a per-run systemd scope', () => {
    expect(chooseIsolation({ userScopeAvailable: true, delegated: true })).toBe('scope');
    expect(chooseIsolation({ userScopeAvailable: true, delegated: false })).toBe('scope');
  });

  it('falls back to a delegated cgroup', () => {
    expect(chooseIsolation({ userScopeAvailable: false, delegated: true })).toBe('delegated');
  });

  it('degrades to none when neither is available', () => {
    expect(chooseIsolation({ userScopeAvailable: false, delegated: false })).toBe('none');
  });
});

describe('survivesRestart', () => {
  it('is honest that `none` does NOT survive a control-group teardown', () => {
    // The whole reason this value is reported on /api/v1/health rather than assumed.
    expect(survivesRestart('none')).toBe(false);
    expect(survivesRestart('scope')).toBe(true);
    expect(survivesRestart('delegated')).toBe(true);
  });

  it('every mode has a description, and the degraded one says so', () => {
    for (const mode of BROKER_ISOLATIONS) expect(describeIsolation(mode).length).toBeGreaterThan(0);
    expect(describeIsolation('none')).toMatch(/degraded/);
    expect(describeIsolation('none')).toMatch(/WILL kill/);
  });
});

describe('buildBrokerLaunchArgv', () => {
  const command = ['/usr/bin/node', '/opt/cezar/packages/cezar/dist/index.js', 'run-broker', '--spool', '/s'];

  it('wraps the broker in a transient scope under the runs slice', () => {
    const argv = buildBrokerLaunchArgv({ isolation: 'scope', runId: 'run-1', command });
    expect(argv[0]).toBe('systemd-run');
    expect(argv).toContain('--user');
    expect(argv).toContain('--scope');
    expect(argv).toContain(`--slice=${RUNS_SLICE}`);
    expect(argv).toContain('--unit=cezar-run-run-1');
    expect(argv.slice(argv.indexOf('--') + 1)).toEqual(command);
  });

  it('honours a custom slice', () => {
    const argv = buildBrokerLaunchArgv({ isolation: 'scope', runId: 'r', command, slice: 'other.slice' });
    expect(argv).toContain('--slice=other.slice');
  });

  it('leaves the command untouched for delegated and none — the escape there is setsid at spawn', () => {
    expect(buildBrokerLaunchArgv({ isolation: 'delegated', runId: 'r', command })).toEqual(command);
    expect(buildBrokerLaunchArgv({ isolation: 'none', runId: 'r', command })).toEqual(command);
  });

  it('returns a copy, never the caller’s array', () => {
    const argv = buildBrokerLaunchArgv({ isolation: 'none', runId: 'r', command });
    argv.push('mutated');
    expect(command).not.toContain('mutated');
  });

  it('is byte-for-byte the pre-D14a argv when resources is omitted — no properties appear unasked', () => {
    const before = buildBrokerLaunchArgv({ isolation: 'scope', runId: 'run-1', command });
    const after = buildBrokerLaunchArgv({
      isolation: 'scope',
      runId: 'run-1',
      command,
      resources: { runMemoryHighMb: null, runMemoryMaxMb: null, runCpuWeight: null, runsSliceMemoryMaxMb: null },
    });
    expect(after).toEqual(before);
    expect(before.some((a) => a.startsWith('--property=') || a.startsWith('--slice-property='))).toBe(false);
  });

  it('wires configured resource bounds in before the `--` command separator', () => {
    const argv = buildBrokerLaunchArgv({
      isolation: 'scope',
      runId: 'run-1',
      command,
      resources: { runMemoryHighMb: 3000, runMemoryMaxMb: 4096, runCpuWeight: 50, runsSliceMemoryMaxMb: 12000 },
    });
    const sep = argv.indexOf('--');
    const flags = argv.slice(0, sep);
    expect(flags).toContain('--property=MemoryHigh=3000M');
    expect(flags).toContain('--property=MemoryMax=4096M');
    expect(flags).toContain('--property=CPUWeight=50');
    expect(flags).toContain('--slice-property=MemoryMax=12000M');
    expect(argv.slice(sep + 1)).toEqual(command);
  });

  it('never emits resource flags for delegated or none, even when resources is set', () => {
    const resources = { runMemoryMaxMb: 4096 };
    expect(buildBrokerLaunchArgv({ isolation: 'delegated', runId: 'r', command, resources })).toEqual(command);
    expect(buildBrokerLaunchArgv({ isolation: 'none', runId: 'r', command, resources })).toEqual(command);
  });
});

describe('buildRunScopeProperties / buildRunsSliceProperties (D14a)', () => {
  it('emits nothing when every bound is null — the default, and the safe published state', () => {
    expect(
      buildRunScopeProperties({ runMemoryHighMb: null, runMemoryMaxMb: null, runCpuWeight: null }),
    ).toEqual([]);
    expect(buildRunsSliceProperties({ runsSliceMemoryMaxMb: null })).toEqual([]);
  });

  it('emits nothing when the object is empty (fields simply absent)', () => {
    expect(buildRunScopeProperties({})).toEqual([]);
    expect(buildRunsSliceProperties({})).toEqual([]);
  });

  it('emits exactly one --property= per configured scope bound, none for the ones left null', () => {
    expect(buildRunScopeProperties({ runMemoryHighMb: 2048, runMemoryMaxMb: null, runCpuWeight: null })).toEqual([
      '--property=MemoryHigh=2048M',
    ]);
    expect(buildRunScopeProperties({ runMemoryHighMb: null, runMemoryMaxMb: 4096, runCpuWeight: null })).toEqual([
      '--property=MemoryMax=4096M',
    ]);
    expect(buildRunScopeProperties({ runMemoryHighMb: null, runMemoryMaxMb: null, runCpuWeight: 25 })).toEqual([
      '--property=CPUWeight=25',
    ]);
  });

  it('emits all three together, in a stable order', () => {
    expect(buildRunScopeProperties({ runMemoryHighMb: 1000, runMemoryMaxMb: 2000, runCpuWeight: 10 })).toEqual([
      '--property=MemoryHigh=1000M',
      '--property=MemoryMax=2000M',
      '--property=CPUWeight=10',
    ]);
  });

  it('the slice ceiling only fires on its own field', () => {
    expect(buildRunsSliceProperties({ runsSliceMemoryMaxMb: 12000 })).toEqual(['--slice-property=MemoryMax=12000M']);
    // A run-scope bound must never leak onto the slice flag.
    expect(buildRunsSliceProperties({ runMemoryMaxMb: 4096 })).toEqual([]);
  });

  it('treats 0 as a real configured value, not as absence — only null/undefined mean "off"', () => {
    expect(buildRunScopeProperties({ runMemoryHighMb: 0 })).toEqual(['--property=MemoryHigh=0M']);
  });
});

describe('detectResourceKill (D14a, C3: never a bare failed step)', () => {
  const cezarInitiated = { cezarInitiated: false };

  it('negative control: no bound configured — a SIGKILL is NOT attributed to a resource kill', () => {
    expect(
      detectResourceKill({ code: null, signal: 'SIGKILL' }, { runMemoryMaxMb: null, runsSliceMemoryMaxMb: null }, cezarInitiated),
    ).toBeUndefined();
  });

  it('negative control: bound configured, but the exit was not a SIGKILL — an ordinary test failure stays a failure', () => {
    expect(detectResourceKill({ code: 1, signal: null }, { runMemoryMaxMb: 4096 }, cezarInitiated)).toBeUndefined();
    expect(detectResourceKill({ code: 0, signal: null }, { runMemoryMaxMb: 4096 }, cezarInitiated)).toBeUndefined();
  });

  it('negative control: bound configured and SIGKILLed, but cezar sent the kill itself (its own timeout/interrupt escalation)', () => {
    expect(
      detectResourceKill({ code: null, signal: 'SIGKILL' }, { runMemoryMaxMb: 4096 }, { cezarInitiated: true }),
    ).toBeUndefined();
  });

  it('reports a named resource kill when a scope MemoryMax was configured and the kill was not ours', () => {
    const result = detectResourceKill({ code: null, signal: 'SIGKILL' }, { runMemoryMaxMb: 4096 }, cezarInitiated);
    expect(result).toEqual({ limit: 'memory', detail: expect.stringContaining('MemoryMax=4096M on the run scope') });
  });

  it('also detects the self-reported form (exit code 137) — a CLI that traps and re-reports SIGKILL', () => {
    const result = detectResourceKill({ code: 137, signal: null }, { runMemoryMaxMb: 4096 }, cezarInitiated);
    expect(result?.limit).toBe('memory');
  });

  it('attributes to the slice ceiling when only the slice bound was configured', () => {
    const result = detectResourceKill(
      { code: null, signal: 'SIGKILL' },
      { runMemoryMaxMb: null, runsSliceMemoryMaxMb: 12000 },
      cezarInitiated,
    );
    expect(result?.detail).toContain(`MemoryMax=12000M on ${RUNS_SLICE}`);
  });

  it('never returns a `cpu` kill — CPUWeight is a scheduling weight, not a hard cap that can fire one', () => {
    // Even with only runCpuWeight configured (no memory bound at all), a SIGKILL is unattributed.
    expect(
      detectResourceKill({ code: null, signal: 'SIGKILL' }, { runCpuWeight: 10 }, cezarInitiated),
    ).toBeUndefined();
  });
});

describe('brokerScopeUnitName', () => {
  it('sanitizes a run id into a valid unit name', () => {
    expect(brokerScopeUnitName('7c2dd8f0-e53e-4e88')).toBe('cezar-run-7c2dd8f0-e53e-4e88');
    expect(brokerScopeUnitName('has/slash and space')).toBe('cezar-run-has-slash-and-space');
  });
});

describe('user-scope availability derives the runtime dir (2026-08-21)', () => {
  /**
   * Measured on prod-host: inside `cezar.service` XDG_RUNTIME_DIR is UNSET, so this probe
   * returned false and isolation degraded to `delegated`. That is not cosmetic — `delegated`
   * leaves the broker in the service's own cgroup, protected only by KillMode=process, which
   * survives `systemctl restart` but NOT a full `stop`. A live run survived seven restarts and
   * then died on the first stop/start.
   */
  const fsWith = (paths: string[]) => ({ existsSync: (p: string) => paths.includes(p) });

  it('finds the user manager even with XDG_RUNTIME_DIR unset', () => {
    const fs = fsWith(['/usr/bin/systemd-run', '/run/user/999/systemd/private']);
    expect(probeUserScope({ PATH: '/usr/bin' }, fs, 999)).toBe(true);
  });

  it('still honours an explicit XDG_RUNTIME_DIR over the derived default', () => {
    const fs = fsWith(['/usr/bin/systemd-run', '/custom/systemd/private']);
    expect(probeUserScope({ PATH: '/usr/bin', XDG_RUNTIME_DIR: '/custom' }, fs, 999)).toBe(true);
    // and does NOT silently fall back to the default when the explicit one is wrong
    expect(probeUserScope({ PATH: '/usr/bin', XDG_RUNTIME_DIR: '/wrong' }, fsWith(['/usr/bin/systemd-run', '/run/user/999/systemd/private']), 999)).toBe(false);
  });

  it('is still false when there is no user manager — the socket is the proof, not the path', () => {
    expect(probeUserScope({ PATH: '/usr/bin' }, fsWith(['/usr/bin/systemd-run']), 999)).toBe(false);
  });

  it('userScopeEnv fills the gap only when the variable is absent', () => {
    expect(userScopeEnv({}, 999)).toEqual({
      XDG_RUNTIME_DIR: '/run/user/999',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/999/bus',
    });
    expect(userScopeEnv({ XDG_RUNTIME_DIR: '/already' }, 999)).toEqual({});
    expect(defaultRuntimeDir(999)).toBe('/run/user/999');
  });
});
