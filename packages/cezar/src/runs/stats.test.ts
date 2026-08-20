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
