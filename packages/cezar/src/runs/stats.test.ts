import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { RunEvent } from '@loki-labs/better-cezar-contract';
import { computeRunStats, dispatchIdsByStructure, formatRunStats, readRunStats } from './stats.ts';
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

  /**
   * The degradation contract, and the reason every assertion above still reads the same number
   * it did before parent/child attribution existed.
   *
   * This recording predates the v2 item stream — it holds `lifecycle`, `step-start`, `tool-call`,
   * `tool-result` and `step-end`, and no `item.*` at all. With no items to read, the meter cannot
   * know who made a call, so it attributes NOTHING to a child and computes exactly what it always
   * did. An old log keeps answering the question it was asked; only `subAgentCalls` gets wider,
   * by falling back to a case-insensitive name match — and `ec6e8e06`'s answer there is still 0,
   * correctly, because it genuinely never dispatched.
   */
  it('attributes nothing to a child on a pre-v2 transcript — every call is the step’s own', () => {
    expect(stats.totals.childToolCalls).toBe(0);
    expect(stats.totals.ownToolCalls).toBe(271);
    expect(stats.totals.ownToolCalls).toBe(stats.totals.toolCalls);
    for (const s of stats.steps) expect(s.childToolCalls).toBe(0);
  });

  it('reports no peak context at all — this run predates `context.updated`', () => {
    expect(stats.totals.peakContextTokens).toBeUndefined();
    for (const s of stats.steps) expect(s.peakContextTokens).toBeUndefined();
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

  /**
   * The bug this meter shipped with: `=== 'Task'` against a backend that says `Agent`.
   *
   * `"tool":"Task"` occurs ZERO times in every transcript on this box; `"tool":"Agent"` occurs
   * three times in each of three separate runs, every one of them reported as `sub 0`. The
   * fallback is now every spelling `core/tool-display.ts` normalises, case-insensitively.
   */
  it('counts Agent and opencode-style task calls too, on a transcript with no v2 items', () => {
    const s = computeRunStats('r', [
      at(1, 'tool-call', { id: 'a', tool: 'Agent' }),
      at(2, 'tool-call', { id: 'b', tool: 'task' }),
      at(3, 'tool-call', { id: 'c', tool: 'Bash' }),
    ]);
    expect(s.totals.subAgentCalls).toBe(2);
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

/**
 * Parent/child attribution and the dispatch counter, against a REAL fanned-out recording
 * (spec `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`, Verification §V2).
 *
 * The fixture is run `c10864d1-5dd1-4c03-b1ea-5443838c7347` — the first run on this box whose
 * read-heavy step actually dispatched sub-agents, and which the old meter reported as `sub 0`.
 * Trimmed to its `spec` and `document` steps and to the event types the meter reads
 * (`step-start`, `step-end`, `tool-call`, `tool-result`, tool `item.started`/`item.completed`,
 * `context.updated`); payloads (`input`, `result`, `output`, `title`) stripped and message items
 * dropped. Every id, `seq`, `stepId`, `tool`, `toolKind`, `parentItemId` and timestamp is
 * verbatim. 3.5 MB and 4 561 events become 101 KB and 613.
 *
 * The two steps are the whole point of the pair: `spec` fanned out three ways, `document` held
 * the same `Task` grant and never used it. They are the "after" and the "before" of the spec's
 * §V4 A/B, pinned here so the baselines cannot drift out of the record.
 */
const FANOUT_FIXTURE = join(fixtureDir, 'c10864d1-trimmed.ndjson');
const FANOUT_RUN_ID = 'c10864d1-5dd1-4c03-b1ea-5443838c7347';
const fanout = await readRunStats(FANOUT_FIXTURE, FANOUT_RUN_ID);
const fanoutStep = (id: string) => {
  const found = fanout.steps.find((s) => s.stepId === id);
  if (!found) throw new Error(`no step "${id}" in fanout stats`);
  return found;
};

describe('computeRunStats — c10864d1, the run the old meter reported as zero fan-out', () => {
  it('counts the three sub-agent dispatches the old `=== Task` counter could not see', () => {
    // THE headline. `"tool":"Task"` never appears in this transcript; `"tool":"Agent"` appears
    // three times, and every one is a `toolKind: 'task'` item in the v2 stream.
    expect(fanoutStep('spec').subAgentCalls).toBe(3);
  });

  it('bills a child’s 70 calls to the child, leaving the parent’s own 16', () => {
    const spec = fanoutStep('spec');
    expect(spec.toolCalls).toBe(86); // unchanged meaning: everything stamped with this step
    expect(spec.childToolCalls).toBe(70); // spent inside the sub-agents' own windows
    expect(spec.ownToolCalls).toBe(16); // what this step's agent actually spent
    expect(spec.ownToolCalls + spec.childToolCalls).toBe(spec.toolCalls);
  });

  it('stops a child’s results from splitting the parent’s batches (16 trips, not 78)', () => {
    // Before this fix the step read 86 calls / 78 round trips / batch 1.10 — fan-out RAISED the
    // number it was supposed to lower. A child `tool-result` is what used to close the batch.
    expect(fanoutStep('spec').roundTrips).toBe(16);
    expect(fanoutStep('spec').batchFactor).toBe(1);
  });

  it('records the peak context of the parent’s window, per step', () => {
    expect(fanoutStep('spec').peakContextTokens).toBe(122_650);
    expect(fanoutStep('document').peakContextTokens).toBe(141_783);
  });

  /**
   * The `document` baseline for the spec's §V4 A/B: the same `Task` grant, never reached for.
   * If a later prompt change works, THESE are the numbers it has to beat.
   */
  it('pins the `document` baseline — Task granted, fan-out never chosen: 38 own calls, sub 0', () => {
    const doc = fanoutStep('document');
    expect(doc.subAgentCalls).toBe(0);
    expect(doc.ownToolCalls).toBe(38);
    expect(doc.childToolCalls).toBe(0);
    expect(doc.roundTrips).toBe(38);
    expect(doc.batchFactor).toBe(1);
  });

  it('bills every dispatch to the DISPATCHING step, never to a child’s', () => {
    expect(fanout.totals.subAgentCalls).toBe(3);
    for (const s of fanout.steps) if (s.stepId !== 'spec') expect(s.subAgentCalls).toBe(0);
  });

  it('takes the MAX peak context across steps, never the sum', () => {
    // 122 650 + 141 783 = 264 433, a number no window ever held. Each step is its own session.
    expect(fanout.totals.peakContextTokens).toBe(141_783);
  });

  /**
   * The rule (`toolKind === 'task'`, minus `Skill`) cross-checked against the structure
   * (an item id that fathered a child item), which is spelling- and Skill-proof for free but
   * blind to a dispatch that produced no children. Measured 3 === 3 === 3 on this transcript.
   *
   * This is the test that turns a FUTURE tool mapped to `toolKind: 'task'` into a red build
   * instead of a silently inflated metric.
   */
  it('agrees with the structural definition of a dispatch, and with the raw `Agent` calls', () => {
    const raw = readFileSync(FANOUT_FIXTURE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunEvent);
    const structural = dispatchIdsByStructure(raw);
    const agentCallIds = new Set(
      raw
        .filter((e) => e.type === 'tool-call' && (e as { tool?: string }).tool === 'Agent')
        .map((e) => (e as { id?: string }).id),
    );
    expect(structural.size).toBe(3);
    expect(agentCallIds.size).toBe(3);
    expect([...structural].sort()).toEqual([...agentCallIds].sort());
    // …and the meter counted exactly that many.
    expect(fanout.totals.subAgentCalls).toBe(structural.size);
  });

  it('prints the child and context columns in the table', () => {
    const text = formatRunStats(fanout);
    expect(text).toContain('child');
    expect(text).toContain('ctx k');
    expect(text).toContain('70 of 124 calls were made by sub-agents');
  });
});

describe('computeRunStats — v2 item attribution, unit cases', () => {
  const at = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent =>
    ({ seq, type, ts: new Date(1_700_000_000_000 + seq * 1_000).toISOString(), stepId: 's', ...extra }) as RunEvent;
  const toolItem = (seq: number, item: Record<string, unknown>): RunEvent =>
    at(seq, 'item.started', { item: { kind: 'tool', ...item } });

  /**
   * `core/tool-display.ts` maps BOTH a sub-agent spawn (`:144-155`) and claude's `Skill`
   * invocation (`:159-165`) to `toolKind: 'task'` — the second only so the two group together in
   * the UI. A bare `toolKind === 'task'` test therefore scores a skill call as fan-out, on
   * `document`, which is the step most likely to invoke one and the step whose fan-out is the
   * go/no-go for the whole spec. One skill call would make it pass with zero delegation.
   */
  it('does NOT count a Skill invocation as fan-out, though it shares toolKind "task"', () => {
    const s = computeRunStats('r', [
      toolItem(1, { id: 'a', name: 'Skill', toolKind: 'task' }),
      at(2, 'tool-call', { id: 'a', tool: 'Skill' }),
      at(3, 'tool-result', { toolCallId: 'a' }),
    ]);
    expect(s.totals.subAgentCalls).toBe(0);
    expect(s.totals.ownToolCalls).toBe(1);
  });

  it('counts a dispatch by toolKind, whatever the backend spells it', () => {
    const s = computeRunStats('r', [
      toolItem(1, { id: 'a', name: 'Agent', toolKind: 'task' }),
      toolItem(2, { id: 'b', name: 'Task', toolKind: 'task' }),
      at(3, 'tool-call', { id: 'a', tool: 'Agent' }),
      at(4, 'tool-call', { id: 'b', tool: 'Task' }),
    ]);
    expect(s.totals.subAgentCalls).toBe(2);
  });

  it('keeps a child’s calls AND results out of the parent’s round trips', () => {
    const s = computeRunStats('r', [
      toolItem(1, { id: 'parent', name: 'Agent', toolKind: 'task' }),
      toolItem(2, { id: 'kid', name: 'Bash', toolKind: 'execute', parentItemId: 'parent' }),
      toolItem(3, { id: 'own2', name: 'Read', toolKind: 'read' }),
      at(4, 'tool-call', { id: 'parent', tool: 'Agent' }),
      // The child runs while the parent's turn is still open. Its result used to close the batch.
      at(5, 'tool-call', { id: 'kid', tool: 'Bash' }),
      at(6, 'tool-result', { toolCallId: 'kid' }),
      at(7, 'tool-call', { id: 'own2', tool: 'Read' }),
      at(8, 'tool-result', { toolCallId: 'parent' }),
      at(9, 'tool-result', { toolCallId: 'own2' }),
    ]);
    expect(s.totals.toolCalls).toBe(3);
    expect(s.totals.childToolCalls).toBe(1);
    expect(s.totals.ownToolCalls).toBe(2);
    // Both own calls rode in ONE turn — which is only visible once the child's result is ignored.
    expect(s.totals.roundTrips).toBe(1);
    expect(s.totals.batchFactor).toBe(2);
    expect(s.totals.subAgentCalls).toBe(1);
  });

  it('leaves a transcript with items but no children exactly as it was', () => {
    const s = computeRunStats('r', [
      toolItem(1, { id: 'a', name: 'Bash', toolKind: 'execute' }),
      toolItem(2, { id: 'b', name: 'Read', toolKind: 'read' }),
      at(3, 'tool-call', { id: 'a', tool: 'Bash' }),
      at(4, 'tool-result', { toolCallId: 'a' }),
      at(5, 'tool-call', { id: 'b', tool: 'Read' }),
      at(6, 'tool-result', { toolCallId: 'b' }),
    ]);
    expect(s.totals.childToolCalls).toBe(0);
    expect(s.totals.ownToolCalls).toBe(s.totals.toolCalls);
    expect(s.totals.roundTrips).toBe(2);
  });

  it('bills a dispatch to the step that made it, not to the step its child ran under', () => {
    const s = computeRunStats('r', [
      toolItem(1, { id: 'p', name: 'Agent', toolKind: 'task' }),
      toolItem(2, { id: 'k', name: 'Grep', toolKind: 'search', parentItemId: 'p' }),
      { seq: 3, type: 'tool-call', ts: '2026-01-01T00:00:00.000Z', stepId: 'context', id: 'p', tool: 'Agent' },
      // The child's events carry the same stepId — that is exactly the bug being fixed.
      { seq: 4, type: 'tool-call', ts: '2026-01-01T00:00:01.000Z', stepId: 'context', id: 'k', tool: 'Grep' },
    ] as unknown as RunEvent[]);
    const context = s.steps.find((step) => step.stepId === 'context');
    expect(context?.subAgentCalls).toBe(1);
    expect(context?.ownToolCalls).toBe(1);
    expect(context?.childToolCalls).toBe(1);
  });

  it('reports peak context per step, and undefined — never 0 — for an unsampled step', () => {
    const s = computeRunStats('r', [
      { seq: 1, type: 'context.updated', ts: '2026-01-01T00:00:00.000Z', stepId: 'a', contextTokens: 40_000 },
      { seq: 2, type: 'context.updated', ts: '2026-01-01T00:00:01.000Z', stepId: 'a', contextTokens: 120_000 },
      { seq: 3, type: 'context.updated', ts: '2026-01-01T00:00:02.000Z', stepId: 'a', contextTokens: 90_000 },
      { seq: 4, type: 'tool-call', ts: '2026-01-01T00:00:03.000Z', stepId: 'b', id: 'x', tool: 'Bash' },
    ] as unknown as RunEvent[]);
    const a = s.steps.find((step) => step.stepId === 'a');
    const b = s.steps.find((step) => step.stepId === 'b');
    expect(a?.peakContextTokens).toBe(120_000); // the max, not the last sample
    // Run `7c2dd8f0`'s `spec` step is this case for real: zero samples while later steps have 294.
    expect(b?.peakContextTokens).toBeUndefined();
    expect(formatRunStats(s)).toContain('—');
  });
});
