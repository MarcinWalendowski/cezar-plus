import { describe, expect, it } from 'vitest';

import {
  DETACHED_ENV,
  buildSystemdRunArgv,
  decideReExec,
  deployLogPath,
  isInsideUnitCgroup,
  readSelfCgroup,
  transientUnitName,
} from './self-safe-deploy.ts';

/**
 * P2 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * The load-bearing case is `isInsideUnitCgroup`: get it wrong in the false direction and the
 * deployer is SIGKILLed by its own restart, which is the exact production failure of 2026-08-19.
 */

/** The real shape on prod-host (cgroup v2, single `0::` line). */
const INSIDE_SERVICE = '0::/system.slice/cezar.service\n';
const INSIDE_NESTED_CHILD = '0::/system.slice/cezar.service/some-child\n';
const OUTSIDE = '0::/user.slice/user-0.slice/session-42.scope\n';
const INSIDE_TRANSIENT = '0::/system.slice/cezar-deploy-20260820T093000Z-67e93cca.service\n';

describe('isInsideUnitCgroup', () => {
  it('detects the service cgroup and any descendant of it', () => {
    expect(isInsideUnitCgroup('cezar.service', INSIDE_SERVICE)).toBe(true);
    expect(isInsideUnitCgroup('cezar.service', INSIDE_NESTED_CHILD)).toBe(true);
  });

  it('is false for an ssh session outside the service', () => {
    expect(isInsideUnitCgroup('cezar.service', OUTSIDE)).toBe(false);
  });

  it('is false inside the transient deploy unit — the recursion guard at the cgroup level', () => {
    expect(isInsideUnitCgroup('cezar.service', INSIDE_TRANSIENT)).toBe(false);
  });

  it('matches a path SEGMENT, never a substring', () => {
    // The prefix trap: a different unit whose name merely starts with ours.
    expect(isInsideUnitCgroup('cezar.service', '0::/system.slice/cezar.service-other.scope\n')).toBe(false);
    expect(isInsideUnitCgroup('cezar', '0::/system.slice/cezar.service\n')).toBe(false);
  });

  it('handles cgroup v1 multi-line files and blank input', () => {
    const v1 = ['12:pids:/system.slice/cezar.service', '0::/system.slice/cezar.service', ''].join('\n');
    expect(isInsideUnitCgroup('cezar.service', v1)).toBe(true);
    expect(isInsideUnitCgroup('cezar.service', '')).toBe(false);
    expect(isInsideUnitCgroup('cezar.service', '\n\n')).toBe(false);
  });
});

describe('readSelfCgroup', () => {
  it('degrades to empty on an unreadable path rather than throwing', () => {
    expect(readSelfCgroup('/definitely/not/a/cgroup/file')).toBe('');
  });
});

describe('decideReExec', () => {
  const base = { unitName: 'cezar.service', systemdRunAvailable: true, cgroupContent: INSIDE_SERVICE };

  it('re-execs when inside the doomed cgroup', () => {
    const d = decideReExec({ ...base, env: {} });
    expect(d.reExec).toBe(true);
    expect(d.reason).toMatch(/SIGKILL/);
  });

  it('does not re-exec twice — the recursion guard', () => {
    expect(decideReExec({ ...base, env: { [DETACHED_ENV]: '1' } }).reExec).toBe(false);
  });

  it('does not re-exec without systemd-run', () => {
    const d = decideReExec({ ...base, env: {}, systemdRunAvailable: false });
    expect(d.reExec).toBe(false);
    expect(d.reason).toMatch(/not available/);
  });

  it('does not re-exec an operator already outside the cgroup', () => {
    const d = decideReExec({ ...base, env: {}, cgroupContent: OUTSIDE });
    expect(d.reExec).toBe(false);
    expect(d.reason).toMatch(/cannot reach this process/);
  });
});

describe('buildSystemdRunArgv', () => {
  const argv = buildSystemdRunArgv({
    releaseId: '20260820T093000Z-67e93cca',
    command: ['/usr/bin/node', '/opt/cezar/packages/cezar/dist/index.js', 'server-deploy'],
    cwd: '/var/lib/cezar/workspace',
  });

  it('names a collectible transient unit with KillMode=process', () => {
    expect(argv[0]).toBe('systemd-run');
    expect(argv).toContain('--unit=cezar-deploy-20260820T093000Z-67e93cca');
    expect(argv).toContain('--collect');
    expect(argv).toContain('--property=KillMode=process');
  });

  it('sets the recursion guard in the child environment', () => {
    expect(argv).toContain(`--setenv=${DETACHED_ENV}=1`);
  });

  it('streams both stdout and stderr to the deploy log', () => {
    const log = deployLogPath('20260820T093000Z-67e93cca');
    expect(argv).toContain(`--property=StandardOutput=append:${log}`);
    expect(argv).toContain(`--property=StandardError=append:${log}`);
  });

  it('separates the command with `--` so its own flags are never eaten by systemd-run', () => {
    const sep = argv.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(argv.slice(sep + 1)).toEqual([
      '/usr/bin/node',
      '/opt/cezar/packages/cezar/dist/index.js',
      'server-deploy',
    ]);
  });

  it('passes extra env after the guard and before the separator', () => {
    const withEnv = buildSystemdRunArgv({ releaseId: 'r1', command: ['true'], setEnv: { FOO: 'bar' } });
    expect(withEnv).toContain('--setenv=FOO=bar');
    expect(withEnv.indexOf('--setenv=FOO=bar')).toBeLessThan(withEnv.indexOf('--'));
  });
});

describe('transientUnitName', () => {
  it('sanitizes characters systemd would reject', () => {
    expect(transientUnitName('20260820T093000Z-67e93cca')).toBe('cezar-deploy-20260820T093000Z-67e93cca');
    expect(transientUnitName('weird/id with spaces')).toBe('cezar-deploy-weird-id-with-spaces');
  });
});
