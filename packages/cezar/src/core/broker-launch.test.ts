import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BROKERED_BACKENDS, brokerArgs, brokerAvailable, brokerPreference, resolveBrokerCommand } from './broker-launch.ts';
import { probeIsolationCapabilities } from './broker-isolation.ts';
import { UNIX_SOCKET_PATH_MAX, controlSocketPath, spoolPaths } from './run-spool.ts';

/**
 * How a broker gets launched, and where its control socket ends up — P4 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 */

describe('brokerPreference / brokerAvailable', () => {
  it('reads the operator override, and treats anything else as auto', () => {
    expect(brokerPreference({ CEZ_RUN_BROKER: '0' })).toBe('off');
    expect(brokerPreference({ CEZ_RUN_BROKER: '1' })).toBe('on');
    expect(brokerPreference({})).toBe('auto');
    // Not `'true'`, not `'yes'` — the same exact-`'1'` discipline every other cezar flag uses, so
    // a typo in a unit file cannot silently turn a feature on.
    expect(brokerPreference({ CEZ_RUN_BROKER: 'true' })).toBe('auto');
  });

  it('`CEZ_RUN_BROKER=0` disables brokering even where it would otherwise work', () => {
    expect(brokerAvailable({ CEZ_RUN_BROKER: '0' })).toBe(false);
  });

  it('is unavailable when running from TypeScript sources — which is every test and every dev run', () => {
    // The broker must be the SAME artifact as the server, so it re-execs this package's built
    // entry point. Under vitest that file does not exist, and the honest answer is "unavailable"
    // rather than a spawn that would fail per run. This is also why the whole existing suite is
    // untouched by brokering.
    expect(resolveBrokerCommand()).toBeNull();
    expect(brokerAvailable({ CEZ_RUN_BROKER: '1' })).toBe(false);
  });

  it('claims only the backends whose stdout a spool can stand in for', () => {
    // A decision, not an omission (spec, "Backend scope"): codex speaks JSON-RPC over a
    // bidirectional transport and opencode runs its own HTTP server.
    expect([...BROKERED_BACKENDS]).toEqual(['claude']);
  });
});

describe('brokerArgs', () => {
  it('puts every broker flag before `--` and the backend command after it', () => {
    const args = brokerArgs({
      spoolDir: '/s',
      runId: 'r1',
      stepId: 'implement',
      backend: 'claude',
      cwd: '/repo',
      command: ['claude', '--output-format', 'stream-json'],
    });
    const separator = args.indexOf('--');
    expect(separator).toBeGreaterThan(0);
    // The separator IS the contract: everything after it is the backend's own command line, flags
    // and all, and must never be parsed as ours.
    expect(args.slice(separator + 1)).toEqual(['claude', '--output-format', 'stream-json']);
    expect(args.slice(0, separator)).toEqual([
      '--spool', '/s', '--run', 'r1', '--backend', 'claude', '--step', 'implement', '--cwd', '/repo',
    ]);
  });

  it('omits optional flags rather than passing empty values', () => {
    const args = brokerArgs({ spoolDir: '/s', runId: 'r1', backend: 'claude', command: ['claude'] });
    expect(args).not.toContain('--step');
    expect(args).not.toContain('--cwd');
  });
});

/**
 * The `sun_path` truncation defect, pinned.
 *
 * Measured on Linux while building this: a 110-character unix socket path binds with NO error and
 * the socket file appears at the TRUNCATED path, not the one requested. `connect` truncates the
 * same way, so control ops keep working and nothing looks wrong — until code reasons about the
 * path as a file, at which point `rmSync` deletes nothing and the stale socket outlives its broker.
 * A 117-character path then failed with `EADDRINUSE` against a directory that was visibly empty.
 */
describe('controlSocketPath', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  it('keeps the socket beside the spool while it fits', () => {
    expect(controlSocketPath('/tmp/x.spool')).toBe('/tmp/x.spool/ctl.sock');
    expect(spoolPaths('/tmp/x.spool').ctl).toBe('/tmp/x.spool/ctl.sock');
  });

  it('falls back to a short path once the spool would overflow sun_path', () => {
    const deep = `/tmp/${'d'.repeat(120)}.spool`;
    const path = controlSocketPath(deep);
    expect(path.startsWith(deep)).toBe(false);
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(UNIX_SOCKET_PATH_MAX);
  });

  it('is deterministic, so a server that restarts finds the same socket with no shared state', () => {
    const deep = `/tmp/${'d'.repeat(120)}.spool`;
    expect(controlSocketPath(deep)).toBe(controlSocketPath(deep));
    // …and distinct per spool, or two runs would fight over one socket.
    expect(controlSocketPath(deep)).not.toBe(controlSocketPath(`${deep}2`));
  });

  it('the fallback path actually binds and is visible as a file', async () => {
    // The point of the fallback: `existsSync` must agree with `bind`, which is exactly what the
    // truncated path broke.
    const base = mkdtempSync(join(tmpdir(), 'cez-ctl-'));
    dirs.push(base);
    const deep = join(base, 'a'.repeat(140) + '.spool');
    mkdirSync(deep, { recursive: true });
    const path = controlSocketPath(deep);
    const server = createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    expect(existsSync(path)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });
});

describe('probeIsolationCapabilities', () => {
  it('needs both a systemd-run binary and a live user manager before claiming scope isolation', () => {
    const caps = probeIsolationCapabilities(
      { PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
      { existsSync: (p) => p === '/usr/bin/systemd-run', accessSync: () => { throw new Error('denied'); } },
    );
    // The binary exists but `/run/user/1000/systemd/private` does not — no user manager, so
    // `systemd-run --user` would fail. `XDG_RUNTIME_DIR` being set is not proof of one.
    expect(caps.userScopeAvailable).toBe(false);
  });

  it('claims scope isolation when the user manager private socket is there', () => {
    const caps = probeIsolationCapabilities(
      { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: '/run/user/1000' },
      {
        existsSync: (p) => p === '/bin/systemd-run' || p === '/run/user/1000/systemd/private',
        accessSync: () => { throw new Error('denied'); },
      },
    );
    expect(caps.userScopeAvailable).toBe(true);
  });

  it('reports no isolation at all rather than guessing, on a host with neither', () => {
    const caps = probeIsolationCapabilities(
      { PATH: '/usr/bin' },
      { existsSync: () => false, accessSync: () => { throw new Error('denied'); } },
    );
    expect(caps).toEqual({ userScopeAvailable: false, delegated: false });
  });
});
