import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { brokerScopeUnitName, buildBrokerLaunchArgv, nextBrokerInstanceId } from './broker-isolation.ts';
import { brokerLaunchLogPath, brokerNeverStarted, ClaudeCliRunner } from './claude-cli-runner.ts';
import type { AgentRunSpec, AgentSession } from './agent-runner.ts';

/** `detach()` lives on `BrokeredSession`, not the `AgentSession` the runner's signature returns.
 *  Every session started here is brokered by construction, so the narrowing is sound. */
const stopPolling = (session: AgentSession): void => (session as unknown as { detach(): void }).detach();

/**
 * The 2026-08-22 production failure, made executable:
 * `.ai/specs/2026-08-22-broker-scope-unit-name-collision.md`.
 *
 * A run spawns one broker per STEP, and the transient scope was named per RUN. A systemd scope
 * stays active while its cgroup is non-empty, so a background process an agent left behind kept the
 * name taken, `systemd-run` exited 1 without starting anything, and — because the launcher's stdio
 * was discarded — the session reported "run broker did not respond after 5000ms", blaming a process
 * that never existed. Five runs died in one morning, and permanently: the lingering process outlives
 * the run, so every later step failed identically.
 *
 * Both halves are covered here, because either one alone leaves the bug expensive: the unique name
 * is the fix, the captured launcher output is what makes the NEXT failure of this shape diagnosable
 * in minutes instead of a morning.
 */

/** Verbatim from prod-host, 2026-08-22 — what `systemd-run` printed and threw away. */
const REFUSAL =
  'Failed to start transient scope unit: Unit cezar-run-29c070f0.scope was already loaded or has a fragment file.';

/** Whatever the runner spawns is a stand-in — nothing here executes a real broker. */
const spawnHook = vi.hoisted(() => ({
  calls: [] as { bin: string; args: string[]; opts: Record<string, unknown> }[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (bin: string, args: string[], opts: Record<string, unknown>) => {
      spawnHook.calls.push({ bin, args, opts });
      const proc = new EventEmitter() as EventEmitter & { unref(): void; pid: number };
      proc.unref = () => undefined;
      proc.pid = 4242;
      return proc;
    },
  };
});

/**
 * `resolveBrokerCommand` looks for a BUILT `dist/index.js` and returns null in a source tree, which
 * would make `spawnBroker` throw before it ever built an argv. Stubbing it is what lets this test
 * exercise the real production path from `startSession` down rather than re-testing
 * `buildBrokerLaunchArgv` in isolation — the wiring is precisely what regressed.
 */
/**
 * Records the options the runner hands `BrokeredSession`, while still constructing a real one.
 *
 * Without this the wiring is untested: mutating `launchFailure: () => brokerNeverStarted(…)` to
 * `() => null` left every other test in this file green, because they all call the helper directly.
 * The bug being fixed was a wiring bug, so the wiring is what has to be pinned.
 */
const sessionHook = vi.hoisted(() => ({ opts: [] as Record<string, unknown>[] }));

vi.mock('./brokered-session.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./brokered-session.ts')>();
  class Recording extends actual.BrokeredSession {
    constructor(opts: ConstructorParameters<typeof actual.BrokeredSession>[0]) {
      sessionHook.opts.push(opts as unknown as Record<string, unknown>);
      super(opts);
    }
  }
  return { ...actual, BrokeredSession: Recording };
});

vi.mock('./broker-launch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./broker-launch.ts')>();
  return { ...actual, resolveBrokerCommand: () => ['/usr/bin/node', '/opt/cezar/dist/index.js', 'run-broker'] };
});

describe('two brokers of the same run never share a scope unit name', () => {
  const dirs: string[] = [];

  afterEach(() => {
    spawnHook.calls.length = 0;
    sessionHook.opts.length = 0;
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-scope-'));
    dirs.push(dir);
    return dir;
  }

  const unitOf = (args: string[]): string =>
    args.find((a) => a.startsWith('--unit=')) ?? '(no --unit)';

  it('gives each STEP of one run its own --unit, keeping the run id as the prefix', () => {
    const cwd = scratch();
    const runId = 'b3b5719c-ccf6-445c-9b97-39dd7eaf077e';
    const spec: AgentRunSpec = { userPrompt: 'go', cwd, timeoutMs: 0 };
    const runner = new ClaudeCliRunner({ bin: '/bin/true', timeoutMs: 0 });

    // Exactly what a run does: `implement`, then `run-tests`, same run, same spool dir.
    for (const [index, stepId] of ['implement', 'run-tests'].entries()) {
      const instanceId = `test-${index + 1}`;
      const spoolDir = join(cwd, '.ai', 'cezar', 'runs', `${runId}.spool`, instanceId);
      const session = runner.startSession(spec, undefined, {
        broker: { spoolDir, runId, instanceId, stepId, isolation: 'scope' },
      });
      // Stop the poll timer; this test is about the launch, and a ref'd interval would hang vitest.
      stopPolling(session);
    }

    expect(spawnHook.calls).toHaveLength(2);
    const [first, second] = spawnHook.calls.map((c) => unitOf(c.args));

    // The regression, stated directly. Before the fix both were `--unit=cezar-run-<runId>`, and the
    // second `systemd-run` refused to start with "Unit … was already loaded".
    expect(first).not.toBe(second);
    // Still greppable as one run's scopes: `systemctl --user list-units 'cezar-run-<runId>*'`.
    for (const unit of [first, second]) expect(unit).toMatch(new RegExp(`^--unit=cezar-run-${runId}-`));
  });

  it('wires the never-started diagnosis into the session — as launchFailure, NOT as spawnFailed', () => {
    const cwd = scratch();
    const spoolDir = join(cwd, '.ai', 'cezar', 'runs', 'r7.spool', 'i7');
    const runner = new ClaudeCliRunner({ bin: '/bin/true', timeoutMs: 0 });
    stopPolling(
      runner.startSession({ userPrompt: 'go', cwd, timeoutMs: 0 }, undefined, {
        broker: { spoolDir, runId: 'r7', instanceId: 'i7', stepId: 'implement', isolation: 'scope' },
      }),
    );

    const opts = sessionHook.opts[0] as {
      spawnFailed?: () => Error | null;
      launchFailure?: () => Error | null;
    };

    // What systemd-run writes on its way out with exit 1 — no spawn `error` event, so the ONLY
    // record of it is the launch log the runner now captures.
    writeFileSync(brokerLaunchLogPath(spoolDir), `${REFUSAL}\n`);

    // The give-up path gets the truth…
    const diagnosed = opts.launchFailure?.();
    expect(diagnosed?.message).toMatch(/was never started/);
    expect(diagnosed?.message).toContain('already loaded');

    // …and `buildResult`'s hook stays null, so a clean detach before the first line is still a
    // clean detach rather than a failed step.
    expect(opts.spawnFailed?.()).toBeNull();
  });

  it('sends the launcher’s own output to a file beside the spool, never to a pipe and never to /dev/null', () => {
    const cwd = scratch();
    const spoolDir = join(cwd, '.ai', 'cezar', 'runs', 'r9.spool', 'i9');
    const runner = new ClaudeCliRunner({ bin: '/bin/true', timeoutMs: 0 });
    stopPolling(
      runner.startSession({ userPrompt: 'go', cwd, timeoutMs: 0 }, undefined, {
        broker: { spoolDir, runId: 'r9', instanceId: 'i9', stepId: 'implement', isolation: 'scope' },
      }),
    );

    const stdio = spawnHook.calls[0]?.opts.stdio as unknown[];
    // stdin stays closed — the broker owns the backend's stdin, we must not hold the other end.
    expect(stdio[0]).toBe('ignore');
    // stdout/stderr are FILE descriptors: numbers, not 'pipe'. A pipe is the thing brokering exists
    // to remove (its read end would die with the server); a file keeps that property and still
    // records why a launch failed.
    expect(typeof stdio[1]).toBe('number');
    expect(typeof stdio[2]).toBe('number');

    // Beside the spool, not inside it — `spawnBroker` deletes the spool dir before every launch, so
    // a log written in there would be erased by the very step whose failure it explains.
    const log = brokerLaunchLogPath(spoolDir);
    expect(dirname(log)).toBe(dirname(dirname(spoolDir)));
    expect(log.startsWith(spoolDir)).toBe(false);
    expect(log).toBe(join(dirname(dirname(spoolDir)), 'r9.broker.log'));
  });
});

describe('giving up names the real cause when no broker was ever started', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-giveup-'));
    dirs.push(dir);
    return dir;
  }

  it('reports "never started" and quotes the launcher, instead of "did not respond"', () => {
    const dir = scratch();
    const spoolDir = join(dir, 'run.spool');
    const log = brokerLaunchLogPath(spoolDir);
    writeFileSync(log, `${REFUSAL}\n`);

    const err = brokerNeverStarted(spoolDir, log);
    expect(err).not.toBeNull();
    // The old message blamed a process that did not exist; the new one must not.
    expect(err?.message).not.toMatch(/did not respond/);
    expect(err?.message).toMatch(/was never started/);
    expect(err?.message).toContain('already loaded');
  });

  it('stays silent — so the timeout message wins — when the broker DID come up and then went quiet', () => {
    const dir = scratch();
    const spoolDir = join(dir, 'run.spool');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(
      join(spoolDir, 'meta.json'),
      JSON.stringify({ schema: 1, runId: 'run', backend: 'claude', pid: process.pid }),
    );
    writeFileSync(brokerLaunchLogPath(spoolDir), `${REFUSAL}\n`);

    // meta.json is the proof a broker ran. Even with noise in the log, claiming "never started"
    // here would be a second false diagnosis in the same place.
    expect(brokerNeverStarted(spoolDir, brokerLaunchLogPath(spoolDir))).toBeNull();
  });

  it('says "never started" with no detail when the launcher died silently', () => {
    const dir = scratch();
    const spoolDir = join(dir, 'run.spool');
    const err = brokerNeverStarted(spoolDir, brokerLaunchLogPath(spoolDir));
    expect(err?.message).toMatch(/was never started/);
    expect(err?.message).not.toMatch(/launcher said/);
  });
});

describe('nextBrokerInstanceId', () => {
  it('never repeats, and survives being used twice in the same millisecond', () => {
    const ids = Array.from({ length: 50 }, () => nextBrokerInstanceId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * The process-start half must be STABLE across calls, and this has to be checked by moving the
   * CLOCK, not by calling fast. `Date.now() - uptime` drifts a millisecond or two — the production
   * E2E caught it producing two different stamps for two launches of the same server — but twenty
   * calls in a tight loop all land in the same millisecond, so the obvious version of this test
   * passed against the buggy code. Driving the clock is what makes it able to fail: with the stamp
   * captured at module load, no later clock movement can reach it; computed per call, an hour of
   * simulated drift changes it immediately.
   */
  it('keeps one stamp for the life of the process, however far the clock moves', () => {
    const first = nextBrokerInstanceId().split('-')[0];
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    const up = vi.spyOn(process, 'uptime').mockReturnValue(1);
    try {
      expect(nextBrokerInstanceId().split('-')[0]).toBe(first);
      expect(nextBrokerInstanceId().split('-')[0]).toBe(first);
    } finally {
      now.mockRestore();
      up.mockRestore();
    }
  });

  it('produces a unit name systemd will accept', () => {
    const unit = brokerScopeUnitName('7c2dd8f0-e53e-4e88', nextBrokerInstanceId());
    expect(unit).toMatch(/^[A-Za-z0-9:_.-]+$/);
    expect(unit.length).toBeLessThan(200);
  });

  it('leaves the name unchanged when no instance id is supplied', () => {
    expect(brokerScopeUnitName('r1')).toBe('cezar-run-r1');
    expect(buildBrokerLaunchArgv({ isolation: 'scope', runId: 'r1', command: ['x'] })).toContain(
      '--unit=cezar-run-r1',
    );
  });
});
