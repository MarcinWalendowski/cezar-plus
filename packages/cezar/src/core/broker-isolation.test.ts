import { describe, expect, it } from 'vitest';

import {
  BROKER_ISOLATIONS,
  RUNS_SLICE,
  brokerScopeUnitName,
  buildBrokerLaunchArgv,
  chooseIsolation,
  describeIsolation,
  survivesRestart,
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
});

describe('brokerScopeUnitName', () => {
  it('sanitizes a run id into a valid unit name', () => {
    expect(brokerScopeUnitName('7c2dd8f0-e53e-4e88')).toBe('cezar-run-7c2dd8f0-e53e-4e88');
    expect(brokerScopeUnitName('has/slash and space')).toBe('cezar-run-has-slash-and-space');
  });
});
