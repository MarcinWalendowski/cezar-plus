import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeCliRunner, reportedResourceKill } from './claude-cli-runner.ts';
import type { BrokerResourceLimits } from './broker-isolation.ts';
import type { AgentRunSpec, AgentSession } from './agent-runner.ts';
import type { SpoolExit } from './run-spool.ts';

/**
 * ONE `resources` object, read down BOTH paths — the launch that applies the bound, and the
 * detector that later blames it (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14a;
 * verification **C3**).
 *
 * This suite exists because the two halves shipped in different packages and drifted apart
 * immediately: `buildBrokerLaunchArgv` accepted `opts.resources` while `spawnBroker` never passed
 * it, so four config keys changed no scope property and `detectResourceKill` returned `undefined`
 * by construction. C3 could not fail, which means it could not pass either — an unrunnable
 * verification wearing the shape of a passing one.
 *
 * So neither half is asserted alone here. Every case builds one `BrokerResourceLimits`, hands that
 * same object to `startSession` and to `reportedResourceKill`, and asserts what each did with it.
 * A future change that bounds the scope without teaching the detector — or the reverse — fails a
 * test rather than producing a run that is killed by a limit nobody can name, or attributed to a
 * limit that was never on the cgroup.
 *
 * The path under test is the real one: `startSession` → `spawnBroker` → `buildBrokerLaunchArgv`,
 * with `spawn` captured. Asserting `buildBrokerLaunchArgv` directly would re-test 0.3's function
 * and leave the wiring — the thing that was actually missing — uncovered.
 */

const spawnHook = vi.hoisted(() => ({ calls: [] as { bin: string; args: string[] }[] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (bin: string, args: string[]) => {
      spawnHook.calls.push({ bin, args });
      const proc = new EventEmitter() as EventEmitter & { unref(): void; pid: number };
      proc.unref = () => undefined;
      proc.pid = 4242;
      return proc;
    },
  };
});

/** `resolveBrokerCommand` finds a BUILT `dist/index.js` and returns null from source, which would
 *  make `spawnBroker` throw before it ever built an argv. Same stub `broker-scope-collision.test.ts`
 *  uses, and for the same reason: the production path from `startSession` down is the subject. */
vi.mock('./broker-launch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./broker-launch.ts')>();
  return { ...actual, resolveBrokerCommand: () => ['/usr/bin/node', '/opt/cezar/dist/index.js', 'run-broker'] };
});

/** `detach()` is `BrokeredSession`'s, not the `AgentSession` the signature returns. Every session
 *  here is brokered by construction, so the narrowing is sound — and a ref'd poll timer hangs
 *  vitest. */
const stopPolling = (session: AgentSession): void => (session as unknown as { detach(): void }).detach();

/** The exit an untrapped cgroup kill produces. */
const SIGKILLED: SpoolExit = { code: null, signal: 'SIGKILL', exitedAt: '2026-08-22T10:00:00.000Z' };

const RESOURCE_FLAG = /Memory(Max|High)|CPUWeight/;

describe('one `resources` object reaches the scope AND the attribution', () => {
  const dirs: string[] = [];

  afterEach(() => {
    spawnHook.calls.length = 0;
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  /** Launches one brokered session with these bounds and returns what `spawn` was handed. The BIN
   *  matters as much as the args: under `scope` the launcher is `systemd-run` and the broker
   *  command moves after `--`, which is what makes the resource properties expressible at all. */
  function launch(resources?: BrokerResourceLimits): { bin: string; args: string[] } {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-res-wire-'));
    dirs.push(cwd);
    const spec: AgentRunSpec = { userPrompt: 'go', cwd, timeoutMs: 0 };
    const runner = new ClaudeCliRunner({ bin: '/bin/true', timeoutMs: 0 });
    stopPolling(
      runner.startSession(spec, undefined, {
        broker: {
          spoolDir: join(cwd, 'r1.spool'),
          runId: 'r1',
          stepId: 'run-tests',
          isolation: 'scope',
          ...(resources ? { resources } : {}),
        },
      }),
    );
    return spawnHook.calls.at(-1) ?? { bin: '(never spawned)', args: [] };
  }

  it('bound configured: the scope carries exactly that number, and a kill is attributed to it', () => {
    // ONE object. Both assertions below read it — that is the whole point of the case.
    const resources: BrokerResourceLimits = {
      runMemoryMaxMb: 4096,
      runMemoryHighMb: 3584,
      runCpuWeight: 50,
      runsSliceMemoryMaxMb: 12288,
    };

    const { args: argv } = launch(resources);
    // The VALUE, not merely the presence of a flag: a wiring that passed a fresh `{}` or a
    // hard-coded default would still produce a `MemoryMax=` here and the test would not notice.
    expect(argv).toContain('--property=MemoryMax=4096M');
    expect(argv).toContain('--property=MemoryHigh=3584M');
    expect(argv).toContain('--property=CPUWeight=50');
    // The slice ceiling is a `--slice-property=`, not a `--property=` — different flag, and it is
    // what keeps `cezar.service` answerable while the runs beneath it saturate the box (C4).
    expect(argv).toContain('--slice-property=MemoryMax=12288M');

    // …and the detector, keyed on the SAME object, names that same bound.
    const kill = reportedResourceKill(SIGKILLED, { isolation: 'scope', resources }, { cezarInitiated: false });
    expect(kill?.limit).toBe('memory');
    expect(kill?.detail).toContain('MemoryMax=4096M');
  });

  it('NEGATIVE CONTROL — no `resources`: no property on the scope, and nothing to attribute', () => {
    // Today's shipped cezar, and every install that has not opted in: the scope exists and carries
    // no resource properties at all.
    const { bin, args: argv } = launch(undefined);

    // Floor FIRST. Without it this case passes for the wrong reason — the same "no MemoryMax"
    // reading would be produced by a launch that never built a systemd-run argv at all, which is
    // exactly the state this suite was written to catch.
    expect(bin).toBe('systemd-run');
    expect(argv.some((arg) => arg.startsWith('--unit=cezar-run-r1-'))).toBe(true);

    expect(argv.filter((arg) => RESOURCE_FLAG.test(arg))).toEqual([]);
    expect(reportedResourceKill(SIGKILLED, { isolation: 'scope' }, { cezarInitiated: false })).toBeUndefined();
  });

  it('NEGATIVE CONTROL — every bound `null`: absent from the scope, never `MemoryMax=0`', () => {
    // `null` is the config schema's explicit "no bound". Emitting `MemoryMax=0` for it would be a
    // real ceiling of zero, which systemd honours — the run would be killed the instant it
    // allocated anything, for a limit the operator wrote to mean the opposite.
    const resources: BrokerResourceLimits = {
      runMemoryMaxMb: null,
      runMemoryHighMb: null,
      runCpuWeight: null,
      runsSliceMemoryMaxMb: null,
    };

    const { bin, args: argv } = launch(resources);
    expect(bin).toBe('systemd-run');
    expect(argv.filter((arg) => RESOURCE_FLAG.test(arg))).toEqual([]);
    expect(argv.join(' ')).not.toContain('=0');

    expect(reportedResourceKill(SIGKILLED, { isolation: 'scope', resources }, { cezarInitiated: false }))
      .toBeUndefined();
  });

  it('one bound of the four: only that property is set, and it is the one named in the attribution', () => {
    // The realistic first tuning step on the box — set the hard ceiling, leave the rest alone. It
    // also separates the two Memory knobs, which is the pair most likely to be confused: only
    // `MemoryMax` can kill, `MemoryHigh` only throttles.
    const resources: BrokerResourceLimits = { runMemoryMaxMb: 512 };

    const { args: argv } = launch(resources);
    expect(argv).toContain('--property=MemoryMax=512M');
    expect(argv.filter((arg) => RESOURCE_FLAG.test(arg))).toEqual(['--property=MemoryMax=512M']);

    const kill = reportedResourceKill(SIGKILLED, { isolation: 'scope', resources }, { cezarInitiated: false });
    expect(kill?.detail).toContain('MemoryMax=512M');
    expect(kill?.detail).toContain('run scope');
  });

  it('outside `scope` isolation the same object bounds nothing and blames nothing', () => {
    // `delegated` and `none` have no cgroup of the launch's own, so `buildBrokerLaunchArgv` returns
    // the command unchanged. The detector has to refuse for the same reason, or a Mac would
    // attribute every stray SIGKILL to a ceiling that has never existed on that machine.
    const resources: BrokerResourceLimits = { runMemoryMaxMb: 512 };
    const cwd = mkdtempSync(join(tmpdir(), 'cez-res-wire-none-'));
    dirs.push(cwd);
    const runner = new ClaudeCliRunner({ bin: '/bin/true', timeoutMs: 0 });
    stopPolling(
      runner.startSession({ userPrompt: 'go', cwd, timeoutMs: 0 }, undefined, {
        broker: { spoolDir: join(cwd, 'r2.spool'), runId: 'r2', stepId: 'run-tests', isolation: 'none', resources },
      }),
    );

    const argv = spawnHook.calls.at(-1)?.args ?? [];
    expect(spawnHook.calls.at(-1)?.bin).toBe('/usr/bin/node'); // no systemd-run wrapper at all
    expect(argv.filter((arg) => RESOURCE_FLAG.test(arg))).toEqual([]);
    expect(reportedResourceKill(SIGKILLED, { isolation: 'none', resources }, { cezarInitiated: false }))
      .toBeUndefined();
  });
});
