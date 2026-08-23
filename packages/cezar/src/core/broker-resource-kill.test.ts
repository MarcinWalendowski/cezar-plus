import { describe, expect, it } from 'vitest';
import { reportedResourceKill } from './claude-cli-runner.ts';
import type { BrokerResourceLimits } from './broker-isolation.ts';
import type { SpoolExit } from './run-spool.ts';

/**
 * The caller `detectResourceKill` was written to expect (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14a; verification **C3**).
 *
 * `detectResourceKill` is pure and clock-free, so on its own it decides nothing about any real
 * run. `reportedResourceKill` is the seam where a broker's observed exit becomes a fact on the
 * record: it adds the two things the pure function deliberately does not have — the instant of
 * observation, and whether the bound it is about to blame was ever actually applied to THIS
 * launch's cgroup.
 *
 * Every case here is paired with its opposite on purpose. A detector that answered "resource
 * kill" to everything would satisfy the positive cases alone, and the run's own agent would then
 * be told a bound killed it every time a step failed — the mirror image of the failure C3 exists
 * to prevent, and just as misleading.
 */

/** A memory bound genuinely configured for the launch — the precondition for any attribution. */
const BOUNDED: BrokerResourceLimits = { runMemoryMaxMb: 512, runCpuWeight: 100 };

/** The shape Node reports when nothing traps the signal: no exit code at all. */
const SIGKILLED: SpoolExit = { code: null, signal: 'SIGKILL', exitedAt: '2026-08-22T10:00:00.000Z' };

const scope = { isolation: 'scope' as const, resources: BOUNDED };

describe('reportedResourceKill — the exit-site caller for detectResourceKill (C3)', () => {
  it('reports a SIGKILL under a configured memory bound, stamped with the observation instant', () => {
    const kill = reportedResourceKill(SIGKILLED, scope, { cezarInitiated: false });
    expect(kill).toBeDefined();
    expect(kill?.limit).toBe('memory');
    // The bound has to be NAMED. "killed" with no reason is what gets blamed on the tests.
    expect(kill?.detail).toContain('MemoryMax=512M');
    // `at` comes from the broker's own `exitedAt`, not from when the tail noticed the file — a
    // re-attach after a restart reads exit.json minutes later and must not restamp the kill.
    expect(kill?.at).toBe('2026-08-22T10:00:00.000Z');
  });

  it('reports the 137 form of the same death (a CLI that traps and re-reports the signal)', () => {
    const kill = reportedResourceKill({ code: 137, signal: null }, scope, { cezarInitiated: false });
    expect(kill?.limit).toBe('memory');
  });

  it('does NOT report an ordinary non-zero exit, with the very same bound configured', () => {
    // The other direction, and the one that makes the test above mean something: a failing gate
    // exits 1. If that were reported as a resource kill, every red test suite on the box would
    // read as the host killing the run.
    expect(reportedResourceKill({ code: 1, signal: null }, scope, { cezarInitiated: false })).toBeUndefined();
    expect(reportedResourceKill({ code: 0, signal: null }, scope, { cezarInitiated: false })).toBeUndefined();
    expect(reportedResourceKill({ code: 2, signal: null }, scope, { cezarInitiated: false })).toBeUndefined();
  });

  it('does NOT report cezar\'s own SIGTERM→SIGKILL escalation as a resource kill', () => {
    // Identical exit, bit for bit — an inactivity teardown or a cancel produces exactly what a
    // cgroup kill produces. `cezarInitiated` is the only thing that separates them, which is why
    // it is passed truthfully from the runner's `terminatedByCezar` rather than assumed false.
    expect(reportedResourceKill(SIGKILLED, scope, { cezarInitiated: true })).toBeUndefined();
    expect(reportedResourceKill({ code: 137, signal: null }, scope, { cezarInitiated: true })).toBeUndefined();
  });

  it('does NOT attribute a kill to a bound that was never applied to this launch', () => {
    // `buildBrokerLaunchArgv` drops `resources` outside `scope` isolation — there is no cgroup of
    // the launch's own to put a property on. So on a Mac (`none`) or a delegated unit, a
    // configured `runMemoryMaxMb` governs nothing, and blaming it for a stray SIGKILL would be
    // inventing a cause. Same config, same exit, three isolations, two answers.
    expect(reportedResourceKill(SIGKILLED, { isolation: 'none', resources: BOUNDED }, { cezarInitiated: false }))
      .toBeUndefined();
    expect(
      reportedResourceKill(SIGKILLED, { isolation: 'delegated', resources: BOUNDED }, { cezarInitiated: false }),
    ).toBeUndefined();
    // Floor: the same call DOES report under `scope`, so the three above are refusing on the
    // isolation and not because the fixture stopped being a kill.
    expect(reportedResourceKill(SIGKILLED, scope, { cezarInitiated: false })).toBeDefined();
  });

  it('does NOT report a kill when no memory bound was configured at all', () => {
    // Today's cezar, everywhere: the scope exists and carries no resource properties. A SIGKILL
    // here has some other cause, and the record must not claim one this design did not create.
    expect(reportedResourceKill(SIGKILLED, { isolation: 'scope' }, { cezarInitiated: false })).toBeUndefined();
    expect(
      reportedResourceKill(SIGKILLED, { isolation: 'scope', resources: { runCpuWeight: 100 } }, { cezarInitiated: false }),
    ).toBeUndefined();
  });

  it('falls back to now when the spool has no usable exit instant', () => {
    const now = new Date('2026-08-22T12:00:00.000Z');
    // Absent — an older broker, or a spool written before the field existed.
    expect(
      reportedResourceKill({ code: null, signal: 'SIGKILL' }, scope, { cezarInitiated: false, now: () => now })?.at,
    ).toBe('2026-08-22T12:00:00.000Z');
    // Present but not a date: the spool schema checks that `exitedAt` is a STRING, not that it
    // parses, so an unparseable value must not be copied onto the record as if it were an instant.
    expect(
      reportedResourceKill({ code: null, signal: 'SIGKILL', exitedAt: 'whenever' }, scope, {
        cezarInitiated: false,
        now: () => now,
      })?.at,
    ).toBe('2026-08-22T12:00:00.000Z');
  });

  it('reports nothing when there is no exit to read', () => {
    expect(reportedResourceKill(null, scope, { cezarInitiated: false })).toBeUndefined();
  });
});
