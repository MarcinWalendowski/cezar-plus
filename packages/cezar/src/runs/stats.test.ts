import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { RunEvent } from '@loki-labs/better-cezar-contract';
import { computeRunStats, formatRunStats, readRunStats } from './stats.ts';
import { runNdjsonPath, runRunStatsCommand } from './stats-cli.ts';

/**
 * The meter, against a REAL recording (spec
 * `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Verification §1).
 *
 * The fixture is run `ec6e8e06-16e4-448f-a7b9-b00411fcc3d0` — the run whose slowness prompted the
 * spec — trimmed to the four event types the meter reads (`step-start`, `step-end`, `tool-call`,
 * `tool-result`) plus its first and last `lifecycle` line as span anchors. Payloads (`input`,
 * `result` bodies) are stripped; every timestamp, id, `tool` and `stepId` is verbatim. 2.4 MB and
 * 2 004 events become 78 KB and 559.
 *
 * The numbers below are not invented for the test — they are the numbers the spec's Problem
 * section states, derived independently from the untrimmed log. If the meter and the spec ever
 * disagree, one of them is wrong and this test is where that shows up.
 */

const fixtureDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'core/__fixtures__/runs');
const FIXTURE = join(fixtureDir, 'ec6e8e06-trimmed.ndjson');
const RUN_ID = 'ec6e8e06-16e4-448f-a7b9-b00411fcc3d0';

const stats = await readRunStats(FIXTURE, RUN_ID);

/**
 * A `--repo` root whose `.ai/cezar/runs/<id>.ndjson` IS the fixture, materialised once.
 *
 * The fixture lives under `src/core/__fixtures__/runs/`, which is not the layout the CLI resolves
 * (`<repo>/.ai/cezar/runs/<id>.ndjson`) — and the CLI resolving that exact path is part of what is
 * under test, so pointing it straight at the fixture would test nothing. `mkdtemp` under the OS
 * temp dir, never inside the repo.
 */
const fixtureRepo = await (async () => {
  const { mkdtemp, mkdir, copyFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'cez-stats-'));
  await mkdir(join(root, '.ai/cezar/runs'), { recursive: true });
  await copyFile(FIXTURE, join(root, '.ai/cezar/runs', `${RUN_ID}.ndjson`));
  return root;
})();
const step = (id: string) => {
  const found = stats.steps.find((s) => s.stepId === id);
  if (!found) throw new Error(`no step "${id}" in stats`);
  return found;
};

describe('computeRunStats — ec6e8e06, the baseline every later phase is judged against', () => {
  it('counts 271 tool calls across 271 round trips — batch factor 1.00, it never batched', () => {
    expect(stats.totals.toolCalls).toBe(271);
    expect(stats.totals.roundTrips).toBe(271);
    expect(stats.totals.batchFactor).toBe(1);
  });

  it('records zero sub-agent calls — fan-out was available and never reached for', () => {
    expect(stats.totals.subAgentCalls).toBe(0);
    for (const s of stats.steps) expect(s.subAgentCalls).toBe(0);
  });

  it('finds the round-trip tax: 231 sub-second calls that did ~29s of work between them', () => {
    expect(stats.totals.cheapCalls).toBe(231);
    expect(stats.totals.cheapExecMs).toBeGreaterThan(28_900);
    expect(stats.totals.cheapExecMs).toBeLessThan(29_900);
    // 85% of the calls, 2.7% of the execution time. That gap IS the problem the spec attacks.
    expect(stats.totals.cheapCalls / stats.totals.toolCalls).toBeGreaterThan(0.84);
  });

  it('splits the hour 65% model / 30% tool execution', () => {
    expect(stats.totals.modelMs).toBeGreaterThan(2_331_000); // 2 354 727 ±1%
    expect(stats.totals.modelMs).toBeLessThan(2_378_000);
    expect(stats.totals.toolExecMs).toBeGreaterThan(1_078_000); // 1 089 008 ±1%
    expect(stats.totals.toolExecMs).toBeLessThan(1_100_000);
    expect(stats.spanMs).toBe(3_689_153); // 61.5 min, first event → last
  });

  /**
   * The regression test for the trap that broke the spec's own first analysis pass.
   *
   * `spec` emitted `step-start` TWICE (13:22:03, then 13:28:12) — it was restarted when its
   * worktree was deleted under it. A `Map<stepId, startTs>` that overwrites on the second start
   * reports 134 s for the slowest-thinking step in the run; the truth is 503 s. Take the FIRST
   * start and the LAST end, always.
   */
  it('takes first-start → last-end for a RESTARTED step (spec ran twice: 503s, not 134s)', () => {
    expect(step('spec').restarts).toBe(1);
    expect(step('spec').wallMs).toBeGreaterThan(502_000);
    expect(step('spec').wallMs).toBeLessThan(503_500);
    // Every other step ran exactly once.
    for (const s of stats.steps) if (s.stepId !== 'spec') expect(s.restarts).toBe(0);
  });

  it('per-step, separates the round-trip-bound steps from the execution-bound ones', () => {
    // spec/implement/document/deploy: model time dwarfs tool time — these are the ones to fix.
    expect(step('spec').modelMs / step('spec').toolExecMs).toBeGreaterThan(20);
    expect(step('implement').modelMs / step('implement').toolExecMs).toBeGreaterThan(9);
    expect(step('deploy').modelMs / step('deploy').toolExecMs).toBeGreaterThan(9);
    // run-tests is the opposite: it is `npm`, and no amount of batching helps it.
    expect(step('run-tests').toolExecMs).toBeGreaterThan(step('run-tests').modelMs);
    expect(step('commit-push').toolExecMs).toBeGreaterThan(step('commit-push').modelMs);
  });

  it('sums the step wall clocks to less than the run span (queueing lives in the difference)', () => {
    expect(stats.totals.wallMs).toBeLessThan(stats.spanMs);
    expect(stats.totals.wallMs).toBeGreaterThan(3_500_000);
  });

  it('covers all seven steps of the spec-to-deploy chain', () => {
    expect(stats.steps.map((s) => s.stepId)).toEqual([
      'spec',
      'implement',
      'run-tests',
      'commit-push',
      'document',
      'deploy',
      'continue-1',
    ]);
  });
});

describe('computeRunStats — round-trip counting', () => {
  const at = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent =>
    ({ seq, type, ts: new Date(1_700_000_000_000 + seq * 1_000).toISOString(), stepId: 's', ...extra }) as RunEvent;

  it('counts back-to-back tool-calls with no result between them as ONE round trip', () => {
    // Three `tool_use` blocks in one assistant turn — the shape the doctrine asks for.
    const s = computeRunStats('r', [
      at(1, 'step-start'),
      at(2, 'tool-call', { id: 'a', tool: 'Bash' }),
      at(3, 'tool-call', { id: 'b', tool: 'Read' }),
      at(4, 'tool-call', { id: 'c', tool: 'Grep' }),
      at(5, 'tool-result', { toolCallId: 'a' }),
      at(6, 'tool-result', { toolCallId: 'b' }),
      at(7, 'tool-result', { toolCallId: 'c' }),
      at(8, 'step-end'),
    ]);
    expect(s.totals.toolCalls).toBe(3);
    expect(s.totals.roundTrips).toBe(1);
    expect(s.totals.batchFactor).toBe(3);
  });

  it('counts a call-result-call-result ladder as one round trip each — the 1.00 baseline', () => {
    const s = computeRunStats('r', [
      at(1, 'tool-call', { id: 'a', tool: 'Bash' }),
      at(2, 'tool-result', { toolCallId: 'a' }),
      at(3, 'tool-call', { id: 'b', tool: 'Bash' }),
      at(4, 'tool-result', { toolCallId: 'b' }),
    ]);
    expect(s.totals.roundTrips).toBe(2);
    expect(s.totals.batchFactor).toBe(1);
  });

  it('never merges a batch across a step boundary', () => {
    const s = computeRunStats('r', [
      { seq: 1, type: 'tool-call', ts: '2026-01-01T00:00:00.000Z', stepId: 'a', id: 'x', tool: 'Bash' },
      { seq: 2, type: 'tool-call', ts: '2026-01-01T00:00:01.000Z', stepId: 'b', id: 'y', tool: 'Bash' },
    ] as unknown as RunEvent[]);
    expect(s.totals.roundTrips).toBe(2);
  });

  it('counts Task calls as sub-agent fan-out', () => {
    const s = computeRunStats('r', [
      at(1, 'tool-call', { id: 'a', tool: 'Task' }),
      at(2, 'tool-call', { id: 'b', tool: 'Task' }),
      at(3, 'tool-result', { toolCallId: 'a' }),
      at(4, 'tool-result', { toolCallId: 'b' }),
    ]);
    expect(s.totals.subAgentCalls).toBe(2);
    expect(s.totals.roundTrips).toBe(1);
  });

  it('drops an implausible gap rather than counting an idle wait as thinking', () => {
    const s = computeRunStats('r', [
      { seq: 1, type: 'tool-call', ts: '2026-01-01T00:00:00.000Z', stepId: 's', id: 'a', tool: 'Bash' },
      { seq: 2, type: 'tool-result', ts: '2026-01-01T00:00:01.000Z', stepId: 's', toolCallId: 'a' },
      // Eight hours parked at `waiting` — not model time.
      { seq: 3, type: 'tool-call', ts: '2026-01-01T08:00:01.000Z', stepId: 's', id: 'b', tool: 'Bash' },
    ] as unknown as RunEvent[]);
    expect(s.totals.modelMs).toBe(0);
  });

  it('reports an empty run as zeroes, not as an error (batchFactor 0)', () => {
    const s = computeRunStats('r', []);
    expect(s.totals).toMatchObject({ toolCalls: 0, roundTrips: 0, batchFactor: 0 });
    expect(s.steps).toEqual([]);
    expect(s.spanMs).toBe(0);
  });
});

/**
 * The waiting + repetition meters (spec `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`,
 * Verification §3).
 *
 * **These are asserted over INLINE events, not over the fixture, and that is deliberate.**
 * `ec6e8e06-trimmed.ndjson` was built by stripping `input` payloads — it is the right fixture for
 * every counter that reads only timestamps and ids, and it is a trap for these two, which read
 * `input.command`. A predicate tested only against it reports 0 for every run regardless of truth
 * and passes while measuring nothing (R7). The fixture's own zeroes are pinned below, WITH the
 * reason, so the next reader does not mistake them for a measurement.
 *
 * Every command below is a real one, copied from the transcripts on the production box.
 */
describe('computeRunStats — waiting on a guess, and re-running what was already run', () => {
  /** Events at an explicit second offset, so exec times are exact rather than incidental. */
  const ev = (seq: number, sec: number, type: string, extra: Record<string, unknown> = {}): RunEvent =>
    ({
      seq,
      type,
      ts: new Date(1_700_000_000_000 + sec * 1_000).toISOString(),
      stepId: 'run-tests',
      ...extra,
    }) as RunEvent;
  const bash = (seq: number, sec: number, id: string, command: string): RunEvent =>
    ev(seq, sec, 'tool-call', { id, tool: 'Bash', input: { command } });
  const done = (seq: number, sec: number, id: string): RunEvent => ev(seq, sec, 'tool-result', { toolCallId: id });

  it('counts a bounded poll loop as a sleep but NOT as a defect — it exits when the job does', () => {
    // 32 of the 39 sleeps measured across five runs look like this. Banning them (which a bare
    // `grep sleep` acceptance criterion would) bans the correct pattern, and would be satisfied
    // by a run that never ran a gate at all.
    const s = computeRunStats('r', [
      bash(1, 0, 'a', 'for i in $(seq 1 60); do grep -q "^EXIT=" /tmp/gate-typecheck.log && break; sleep 2; done'),
      done(2, 30, 'a'),
    ]);
    expect(s.totals.sleepCalls).toBe(1);
    expect(s.totals.blindSleepCalls).toBe(0);
    // Exec time on a poll loop is mostly the JOB, which is why it is reported apart from the count.
    expect(s.totals.sleepExecMs).toBe(30_000);
  });

  it('counts a bare `sleep 120` before grepping a log as blind — the archetype of the defect', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', 'set +e\nsleep 120; tail -12 /tmp/full-suite-mine.log'),
      done(2, 120, 'a'),
    ]);
    expect(s.totals.sleepCalls).toBe(1);
    expect(s.totals.blindSleepCalls).toBe(1);
    expect(s.totals.sleepExecMs).toBe(120_000);
  });

  it('never drops a blind sleep that has no recorded result — the one you most need to see', () => {
    // Why the predicate runs on `tool-call` and not on matched pairs: the join dropped 2 of 18
    // sleeps on run `7c2dd8f0`, and BOTH were blind. A defect counter whose target is zero must
    // not under-report, and a wait that never returned is the worst one to hide.
    const s = computeRunStats('r', [bash(1, 0, 'a', 'sleep 240; grep -c FAIL /tmp/out.log')]);
    expect(s.totals.blindSleepCalls).toBe(1);
    // …and it contributes no exec time, because there is none to measure.
    expect(s.totals.sleepExecMs).toBe(0);
  });

  it('ignores a `sleep` being WRITTEN INTO a heredoc — that call waits for nothing', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', "cat > /tmp/cutover-experiment.sh <<'SCRIPT'\nsleep 25\nsleep 40\nSCRIPT\nchmod +x /tmp/cutover-experiment.sh"),
      done(2, 1, 'a'),
    ]);
    expect(s.totals.sleepCalls).toBe(0);
    expect(s.totals.blindSleepCalls).toBe(0);
  });

  it('ignores `sleep 0`, and is not fooled by the English word "for" inside a heredoc', () => {
    // Measured: stripping heredocs ALONE is net-zero. It removes one false blind (above) and
    // creates another — here, prose inside the python body was acting as the `for` guard, so
    // stripping correctly exposes a `sleep 0`, which is not a wait either. Hence the duration test.
    const s = computeRunStats('r', [
      bash(1, 0, 'a', "python3 - <<'EOF'\n# poll the sweep for the Wave A gate\nprint(1)\nEOF\nsleep 0; cat /tmp/sweep.json"),
      done(2, 1, 'a'),
    ]);
    expect(s.totals.sleepCalls).toBe(0);
  });

  it('still catches a blind sleep AFTER the heredoc terminator', () => {
    // The negative control for the case above: only the BODY is dropped, never the rest of the
    // command. This exact shape is one of `c10864d1`'s two blind sleeps.
    const s = computeRunStats('r', [
      bash(1, 0, 'a', "python3 - <<'PYEOF'\nprint('start')\nPYEOF\nsleep 60 2>/dev/null; python3 sweep-status.py"),
      done(2, 60, 'a'),
    ]);
    expect(s.totals.blindSleepCalls).toBe(1);
  });

  it('counts re-running one expensive command for a DIFFERENT FILTER as repetition', () => {
    // `7c2dd8f0` ran one test file 11 times — 37 s the first time, 230 s of pure repetition after
    // — changing only the filter each time. An exact-command key finds none of this (measured: 0
    // across all five runs), which is why the key drops everything past the first `|` or `>`.
    const s = computeRunStats('r', [
      bash(1, 0, 'a', 'npm test -- packages/cezar/src/core/brokered-session.test.ts | grep -E "FAIL|✓"'),
      done(2, 37, 'a'),
      bash(3, 40, 'b', 'npm test -- packages/cezar/src/core/brokered-session.test.ts | grep "Test Files"'),
      done(4, 77, 'b'),
      bash(5, 80, 'c', 'npm test -- packages/cezar/src/core/brokered-session.test.ts > /tmp/one.log'),
      done(6, 117, 'c'),
    ]);
    expect(s.totals.repeatedExpensiveCalls).toBe(2);
  });

  it('does not count a repeat whose FIRST call was cheap — that is not the defect', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', 'npm run typecheck'),
      done(2, 2, 'a'),
      bash(3, 4, 'b', 'npm run typecheck | tail -5'),
      done(4, 6, 'b'),
    ]);
    expect(s.totals.repeatedExpensiveCalls).toBe(0);
  });

  it('does not group two genuinely different gates together', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', 'npm run typecheck'),
      done(2, 20, 'a'),
      bash(3, 22, 'b', 'npm test'),
      done(4, 60, 'b'),
    ]);
    expect(s.totals.repeatedExpensiveCalls).toBe(0);
  });

  it('reads no command out of a non-Bash call, and survives a missing `input` entirely', () => {
    const s = computeRunStats('r', [
      ev(1, 0, 'tool-call', { id: 'a', tool: 'Read', input: { file_path: '/tmp/sleep 30' } }),
      ev(2, 1, 'tool-call', { id: 'b', tool: 'Bash' }),
      done(3, 2, 'b'),
    ]);
    expect(s.totals.sleepCalls).toBe(0);
    expect(s.totals.repeatedExpensiveCalls).toBe(0);
  });

  it('reports ZERO on the ec6e8e06 fixture because its `input` was STRIPPED, not because it never waited', () => {
    // R7, pinned so it cannot be misread. This is the trap the spec names: a sleep counter tested
    // only against this fixture passes while measuring nothing at all.
    expect(stats.totals.sleepCalls).toBe(0);
    expect(stats.totals.blindSleepCalls).toBe(0);
    expect(stats.totals.repeatedExpensiveCalls).toBe(0);
    // The proof that the zero is the fixture's and not the meter's: 271 real Bash-and-friends
    // calls are in there, and every one of them arrives with no command to read.
    expect(stats.totals.toolCalls).toBe(271);
  });
});

describe('formatRunStats', () => {
  it('names every step, the totals row, and the two headline numbers', () => {
    const text = formatRunStats(stats);
    expect(text).toContain(RUN_ID);
    for (const id of ['spec', 'implement', 'run-tests', 'commit-push', 'document', 'deploy']) {
      expect(text).toContain(id);
    }
    expect(text).toContain('TOTAL');
    expect(text).toContain('batch factor 1.00');
    expect(text).toContain('(1.00 = never batched)');
    expect(text).toContain('231 cheap calls');
    // The waiting + repetition columns and their summary clause. The fixture's `input` is
    // stripped, so these are structurally present and numerically zero — see the R7 pin above.
    expect(text).toContain('sleep');
    expect(text).toContain('re-run');
    expect(text).toContain('sleep 0 blind of 0');
    expect(text).toContain('0 expensive call(s) re-run');
    // A restarted step is marked as such rather than silently averaged away.
    expect(text).toMatch(/spec \(×2\)/);
  });
});

describe('cez run stats — the command', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l) } };
  };

  it('resolves <repo>/.ai/cezar/runs/<id>.ndjson', () => {
    expect(runNdjsonPath('/repo', 'abc')).toBe('/repo/.ai/cezar/runs/abc.ndjson');
  });

  it('prints the table for a real transcript', async () => {
    const { out, io: sink } = io();
    // `--repo` points at the fixture's own tree: `<dir>/.ai/cezar/runs/<id>.ndjson`.
    const code = await runRunStatsCommand([RUN_ID, '--repo', fixtureRepo], { repoRoot: '/nonexistent', io: sink });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('batch factor 1.00');
  });

  it('--json round-trips through the RunStats shape', async () => {
    const { out, io: sink } = io();
    const code = await runRunStatsCommand([RUN_ID, '--json', '--repo', fixtureRepo], {
      repoRoot: '/nonexistent',
      io: sink,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n')) as typeof stats;
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.totals.toolCalls).toBe(271);
    expect(parsed.steps).toHaveLength(7);
    expect(parsed).toEqual(stats);
  });

  it('exits non-zero when the run has no transcript', async () => {
    const { err, io: sink } = io();
    const code = await runRunStatsCommand(['no-such-run'], { repoRoot: '/nonexistent', io: sink });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no transcript');
  });

  it('refuses a run id that could climb out of the runs directory', async () => {
    const { err, io: sink } = io();
    expect(await runRunStatsCommand(['../../etc/passwd'], { repoRoot: '/tmp', io: sink })).toBe(1);
    expect(err.join('\n')).toContain('invalid run id');
  });

  it('requires a run id', async () => {
    const { err, io: sink } = io();
    expect(await runRunStatsCommand([], { repoRoot: '/tmp', io: sink })).toBe(1);
    expect(err.join('\n')).toContain('a run id is required');
  });
});
