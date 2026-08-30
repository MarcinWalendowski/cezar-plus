import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { countTokens } from 'gpt-tokenizer';

import type { RunEvent } from '@loki-labs/cezar-plus-contract';
import {
  computeRunStats,
  dispatchIdsByStructure,
  formatRunStats,
  parseTranscriptResponses,
  readRunStats,
  type TokenBreakdown,
  type TranscriptResponse,
} from './stats.ts';
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

/**
 * The heredoc/file-write economy meter (spec
 * `.ai/specs/2026-08-21-edit-an-existing-file-never-re-emit-it.md`, Verification §1).
 *
 * Inline events, not the fixture — R7 of that spec, same reasoning as the sleep/repetition meters
 * above: both stats fixtures have `input` stripped, so a character metric tested only against them
 * measures zero forever and passes.
 */
describe('computeRunStats — edit an existing file, never re-emit it', () => {
  const ev = (seq: number, sec: number, type: string, extra: Record<string, unknown> = {}): RunEvent =>
    ({
      seq,
      type,
      ts: new Date(1_700_000_000_000 + sec * 1_000).toISOString(),
      stepId: 'implement',
      ...extra,
    }) as RunEvent;
  const bash = (seq: number, sec: number, id: string, command: string): RunEvent =>
    ev(seq, sec, 'tool-call', { id, tool: 'Bash', input: { command } });
  const done = (seq: number, sec: number, id: string): RunEvent => ev(seq, sec, 'tool-result', { toolCallId: id });

  it('counts a heredoc body separately from the command that carries it', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', "cat > .ai/specs/x.md <<'EOF'\nline one\nline two\nEOF"),
      done(2, 1, 'a'),
    ]);
    expect(s.totals.heredocFileWrites).toBe(1);
    expect(s.totals.heredocRewrites).toBe(0); // a NEW file is not the defect
    expect(s.totals.heredocChars).toBeGreaterThan(0);
    expect(s.totals.heredocChars).toBeLessThan(s.totals.toolInputChars);
  });

  it('charges a re-emission only for the lines it carried unchanged', () => {
    const p = '.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md';
    const s = computeRunStats('r', [
      bash(1, 0, 'a', `cat > ${p} <<'SPECEOF'\nkept one\nkept two\nSPECEOF`),
      done(2, 1, 'a'),
      bash(3, 2, 'b', `cat > ${p} <<'SPECEOF'\nkept one\nkept two\nbrand new\nSPECEOF`),
      done(4, 3, 'b'),
    ]);
    expect(s.totals.heredocFileWrites).toBe(2);
    expect(s.totals.heredocRewrites).toBe(1);
    // 'kept one\n' + 'kept two\n' — the two lines paid for twice. NOT 'brand new'.
    expect(s.totals.heredocRewriteWasteChars).toBe('kept one\n'.length + 'kept two\n'.length);
  });

  it('charges a TOTAL rewrite almost nothing — R11, the reason the gate is chars not count', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', "cat > doc.md <<'EOF'\nalpha\nbravo\nEOF"),
      done(2, 1, 'a'),
      bash(3, 2, 'b', "cat > doc.md <<'EOF'\ncharlie\ndelta\nEOF"),
      done(4, 3, 'b'),
    ]);
    expect(s.totals.heredocRewrites).toBe(1); // the count still flags it…
    expect(s.totals.heredocRewriteWasteChars).toBe(0); // …and the gate correctly does not.
  });

  it('matches `tee` and the trailing-redirect ordering, which the first predicate could not', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', "tee -a notes.md <<'EOF'\nx\nEOF"),
      done(2, 1, 'a'),
      bash(3, 2, 'b', "cat <<'EOF' > other.md\ny\nEOF"),
      done(4, 3, 'b'),
    ]);
    expect(s.totals.heredocFileWrites).toBe(2);
  });

  it('scores a heredoc write to a path the run already READ as a re-emission', () => {
    const s = computeRunStats('r', [
      ev(1, 0, 'tool-call', { id: 'a', tool: 'Read', input: { file_path: 'src/x.ts' } }),
      done(2, 1, 'a'),
      bash(3, 2, 'b', "cat > src/x.ts <<'EOF'\nwhole new body\nEOF"),
      done(4, 3, 'b'),
    ]);
    expect(s.totals.heredocRewrites).toBe(1);
  });

  it('does NOT score a script as a file write, in either redirect position', () => {
    const s = computeRunStats('r', [
      bash(1, 0, 'a', "python3 - <<'PYEOF'\nimport io\ns = io.open('a.ts').read()\nPYEOF"),
      done(2, 1, 'a'),
      bash(3, 2, 'b', "python3 - <<'PY' > /tmp/out.txt\nprint(1)\nPY"),
      done(4, 3, 'b'),
    ]);
    expect(s.totals.heredocFileWrites).toBe(0); // the body is a SCRIPT; /tmp/out.txt is its stdout
    expect(s.totals.heredocChars).toBeGreaterThan(0);
  });

  it('documents the `stripHeredocs` blind spot instead of widening it (R9/§ Data models)', () => {
    // The tag is not at end of line, so `stripHeredocs` — which `signalsOf` also depends on — does
    // not see this body. Accepted: under-count against 7 correct rejections of JS sources
    // containing `<<`. If this ever fails, someone widened the stripper.
    const s = computeRunStats('r', [bash(1, 0, 'a', "python3 - <<'PY' > /tmp/out.txt\nprint(1)\nPY"), done(2, 1, 'a')]);
    expect(s.totals.heredocChars).toBe(0);
  });

  it('pins the serialization — the baseline is JSON.stringify, NOT python json.dumps (R9)', () => {
    const input = { command: 'héllo <<EOF' };
    const s = computeRunStats('r', [ev(1, 0, 'tool-call', { id: 'a', tool: 'Bash', input })]);
    expect(s.totals.toolInputChars).toBe(JSON.stringify(input).length);
    // Guards the exact failure revision 1 of the spec shipped: `{"command":"héllo <<EOF"}` is 25
    // characters, where python's `json.dumps` default (`", "`/`": "` separators + \uXXXX escaping)
    // gives 31.
    expect(s.totals.toolInputChars).toBe(25);
  });

  it('reports ZERO chars on both fixtures because their `input` was STRIPPED, not because they never wrote', () => {
    expect(stats.totals.toolInputChars).toBe(0);
    expect(stats.totals.heredocChars).toBe(0);
    expect(stats.totals.heredocFileWrites).toBe(0);
    expect(stats.totals.heredocRewriteWasteChars).toBe(0);
    // The proof the zero is the fixture's, not the meter's: 271 real tool calls are in there.
    expect(stats.totals.toolCalls).toBe(271);
    expect(fanout.totals.toolInputChars).toBe(0);
    expect(fanout.totals.heredocFileWrites).toBe(0);
    expect(fanout.totals.toolCalls).toBe(124);
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

/**
 * `TokenBreakdown` (`.ai/specs/2026-08-21-output-token-attribution.md`, Phase 2, revision 8) — a
 * replay-time reconstruction of a step's output-token composition, in one of three modes:
 * `'unavailable'` (no `item.*` events, or no `tokenize` supplied), `'basic'` (NDJSON only), or
 * `'calibrated'` (NDJSON + a joined Claude Code session transcript). These tests use a trivial
 * `text => text.length` stub tokenizer, so every expected number is exact arithmetic, not
 * something to eyeball against a BPE vocabulary — and hand-built `TranscriptResponse[]` maps,
 * never a real file (D3: `computeRunStats` is pure and synchronous, `transcripts?` is a plain
 * parameter). The real tokenizer and real transcript PARSING (`parseTranscriptResponses`) are
 * exercised separately, below.
 */
describe('computeRunStats — token breakdown, basic mode (no transcripts)', () => {
  const at = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent =>
    ({ seq, type, ts: new Date(1_700_000_000_000 + seq * 1_000).toISOString(), stepId: 's', ...extra }) as RunEvent;
  const charTokenize = (text: string): number => text.length;

  it('computes narration/toolArg/thinking/measured/unclassifiedGap for a step with known content', () => {
    const s = computeRunStats(
      'r',
      [
        at(1, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'Hello world' } }),
        at(2, 'item.completed', { item: { kind: 'reasoning', id: 'r1', text: 'Real thinking text' } }),
        at(3, 'item.completed', {
          item: { kind: 'tool', id: 't1', name: 'Bash', toolKind: 'execute', status: 'completed', input: { command: 'ls' } },
        }),
        at(4, 'turn.completed', { turnId: 'turn_1', stopReason: 'end_turn', usage: { input: 5, output: 50, total: 55 } }),
      ],
      undefined,
      charTokenize,
    );
    const toolInputChars = JSON.stringify({ command: 'ls' }).length;
    const tb = s.steps[0]?.tokenBreakdown;
    expect(tb).toEqual({
      mode: 'basic',
      reportedTokens: 50,
      narrationTokens: 'Hello world'.length,
      toolArgTokens: toolInputChars,
      childToolArgTokens: 0,
      thinkingTokens: 'Real thinking text'.length,
      measuredTokens: 'Hello world'.length + toolInputChars + 'Real thinking text'.length,
      unclassifiedGapTokens: 50 - ('Hello world'.length + toolInputChars + 'Real thinking text'.length),
      opaqueBlocks: undefined,
    });
  });

  it('mode is unavailable when the step has no item.* events, even with a turn.completed', () => {
    const s = computeRunStats(
      'r',
      [at(1, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 10, total: 11 } })],
      undefined,
      charTokenize,
    );
    expect(s.steps[0]?.tokenBreakdown).toEqual({ mode: 'unavailable', reportedTokens: 10, opaqueBlocks: undefined });
  });

  it('mode is unavailable when no tokenize function is supplied at all, even with items', () => {
    const s = computeRunStats('r', [
      at(1, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'hi' } }),
      at(2, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 10, total: 11 } }),
    ]);
    const tb = s.steps[0]?.tokenBreakdown;
    expect(tb?.mode).toBe('unavailable');
    expect(tb?.narrationTokens).toBeUndefined();
    expect(tb?.reportedTokens).toBe(10);
  });

  it('a tool item.completed with parentItemId lands in childToolArgTokens, excluded from toolArgTokens/measuredTokens (R12)', () => {
    const s = computeRunStats(
      'r',
      [
        at(1, 'item.completed', {
          item: { kind: 'tool', id: 'own1', name: 'Bash', toolKind: 'execute', status: 'completed', input: { command: 'ls' } },
        }),
        at(2, 'item.completed', {
          item: {
            kind: 'tool',
            id: 'kid1',
            name: 'Grep',
            toolKind: 'search',
            status: 'completed',
            input: { pattern: 'x' },
            parentItemId: 'own1',
          },
        }),
        at(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 100, total: 101 } }),
      ],
      undefined,
      charTokenize,
    );
    const tb = s.steps[0]?.tokenBreakdown!;
    expect(tb.toolArgTokens).toBe(JSON.stringify({ command: 'ls' }).length);
    expect(tb.childToolArgTokens).toBe(JSON.stringify({ pattern: 'x' }).length);
    expect(tb.measuredTokens).toBe((tb.narrationTokens ?? 0) + (tb.toolArgTokens ?? 0) + (tb.thinkingTokens ?? 0));
  });

  it('a message/reasoning item.completed with parentItemId is excluded by reading the field directly, not via ItemIndex.childIds (D5)', () => {
    const s = computeRunStats(
      'r',
      [
        at(1, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'own narration' } }),
        at(2, 'item.completed', {
          item: { kind: 'message', id: 'm2', role: 'assistant', text: 'sub-agent narration', parentItemId: 'task1' },
        }),
        at(3, 'item.completed', { item: { kind: 'reasoning', id: 'r2', text: 'sub-agent thinking', parentItemId: 'task1' } }),
        at(4, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 100, total: 101 } }),
      ],
      undefined,
      charTokenize,
    );
    const tb = s.steps[0]?.tokenBreakdown!;
    expect(tb.narrationTokens).toBe('own narration'.length);
    expect(tb.thinkingTokens).toBe(0);
  });

  it('a state-loss tool completion (no input on item.completed) falls back to item.started’s input, deduped by id', () => {
    const s = computeRunStats(
      'r',
      [
        at(1, 'item.started', {
          item: { kind: 'tool', id: 't1', name: 'Bash', toolKind: 'execute', status: 'running', input: { command: 'ls -la' } },
        }),
        // item.completed lost the input (claude-ui-mapper.ts:454's state-loss path) — no `input` key at all.
        at(2, 'item.completed', { item: { kind: 'tool', id: 't1', name: 'Bash', toolKind: 'execute', status: 'completed' } }),
        at(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 100, total: 101 } }),
      ],
      undefined,
      charTokenize,
    );
    expect(s.steps[0]?.tokenBreakdown?.toolArgTokens).toBe(JSON.stringify({ command: 'ls -la' }).length);
  });

  it('treats an absent tool input as 0 tokens, not an error', () => {
    const s = computeRunStats(
      'r',
      [
        at(1, 'item.completed', { item: { kind: 'tool', id: 't1', name: 'TaskList', toolKind: 'plan', status: 'completed' } }),
        at(2, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 5, total: 6 } }),
      ],
      undefined,
      charTokenize,
    );
    expect(s.steps[0]?.tokenBreakdown?.toolArgTokens).toBe(0);
  });

  it('opaqueBlocks is undefined, never 0, when no turn in the step carries blockCounts (pre-Phase-1 run) — pins N2', () => {
    const s = computeRunStats(
      'r',
      [
        at(1, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'hi' } }),
        at(2, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 10, total: 11 } }),
      ],
      undefined,
      charTokenize,
    );
    expect(s.steps[0]?.tokenBreakdown?.opaqueBlocks).toBeUndefined();
  });

  it('opaqueBlocks sums blockCounts.{redactedThinking,serverToolUse,other} — never text/thinking/toolUse', () => {
    const s = computeRunStats(
      'r',
      [
        at(1, 'turn.completed', {
          turnId: 't1',
          stopReason: 'end_turn',
          usage: { input: 1, output: 100, total: 101 },
          blockCounts: { text: 9, thinking: 9, thinkingWithheld: 9, toolUse: 9, redactedThinking: 2, serverToolUse: 1, other: 3 },
        }),
      ],
      undefined,
      charTokenize,
    );
    expect(s.steps[0]?.tokenBreakdown).toMatchObject({ opaqueBlocks: 6 });
  });

  it('recomputes totals from SUMMED-across-defined-steps figures, never averaged (R9)', () => {
    const s = computeRunStats(
      'r',
      [
        { seq: 1, type: 'item.completed', ts: '2026-01-01T00:00:00.000Z', stepId: 'a', item: { kind: 'message', id: 'ma', role: 'assistant', text: 'x'.repeat(90) } },
        { seq: 2, type: 'turn.completed', ts: '2026-01-01T00:00:01.000Z', stepId: 'a', turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 100, total: 101 } },
        { seq: 3, type: 'item.completed', ts: '2026-01-01T00:00:02.000Z', stepId: 'b', item: { kind: 'message', id: 'mb', role: 'assistant', text: 'x'.repeat(500) } },
        { seq: 4, type: 'turn.completed', ts: '2026-01-01T00:00:03.000Z', stepId: 'b', turnId: 't2', stopReason: 'end_turn', usage: { input: 1, output: 1000, total: 1001 } },
      ] as unknown as RunEvent[],
      undefined,
      charTokenize,
    );
    const totals = s.totals.tokenBreakdown!;
    expect(totals.reportedTokens).toBe(1100);
    expect(totals.measuredTokens).toBe(590);
    expect(totals.mode).toBe('basic');
  });

  it('formatRunStats prints the unavailable branch, never a fake-zero row', () => {
    const s = computeRunStats(
      'r',
      [at(1, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 10, total: 11 } })],
      undefined,
      charTokenize,
    );
    const text = formatRunStats(s);
    expect(text).toContain('breakdown unavailable');
  });

  it('omits the breakdown block entirely when no step has a turn.completed at all', () => {
    const s = computeRunStats('r', [at(1, 'tool-call', { id: 'a', tool: 'Bash' })], undefined, charTokenize);
    expect(formatRunStats(s)).not.toContain('output tokens — where they went');
  });
});

/**
 * Calibrated mode — `computeRunStats` fed hand-built `TranscriptResponse[]` maps directly (D3: no
 * filesystem access in this suite; real transcript PARSING is tested separately below).
 */
describe('computeRunStats — token breakdown, calibrated mode (hand-built transcripts)', () => {
  const at = (seq: number, type: string, extra: Record<string, unknown> = {}): RunEvent =>
    ({ seq, type, ts: new Date(1_700_000_000_000 + seq * 1_000).toISOString(), stepId: 's', ...extra }) as RunEvent;
  const charTokenize = (text: string): number => text.length;

  function tr(overrides: Partial<TranscriptResponse> & { messageId: string; outputTokens: number }): TranscriptResponse {
    return { thinkingBearing: false, visibleChars: 0, thinkingChars: 0, visibleText: '', ...overrides };
  }

  it('classifies free vs bearing responses, pools a run-wide tokenScaleFactor, and infers withheldThinkingTokens (D6)', () => {
    const transcripts = new Map<string, TranscriptResponse[]>([
      [
        'sess-a',
        [
          tr({ messageId: 'msg1', outputTokens: 100, thinkingBearing: false, visibleChars: 200, visibleText: 'x'.repeat(200) }),
          // blank thinking — withheld. visibleText is the response's own visible (non-thinking)
          // text; with charTokenize, tokenize(visibleText) === visibleChars by construction here.
          tr({ messageId: 'msg2', outputTokens: 300, thinkingBearing: true, visibleChars: 100, visibleText: 'y'.repeat(100) }),
        ],
      ],
    ]);
    const s = computeRunStats(
      'r',
      [
        at(1, 'session.started', { sessionId: 'sess-a', backend: 'claude' }),
        at(2, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'own narration' } }),
        at(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 400, total: 401 } }),
      ],
      transcripts,
      charTokenize,
    );
    const tb = s.steps[0]?.tokenBreakdown!;
    expect(tb.mode).toBe('calibrated');
    // calibrationRatio (diagnostic only, D6) = freeChars/freeTokens = 200/100 = 2
    expect(tb.calibration?.appliedRatio).toBe(2);
    // tokenScaleFactor = freeTokens/freeTokenized = 100/charTokenize('x'.repeat(200)) = 100/200 = 0.5
    expect(tb.calibration?.appliedScaleFactor).toBe(0.5);
    // bearingVisibleTokenized = charTokenize('y'.repeat(100)) = 100; withheld = 300 - 100*0.5 = 250
    expect(tb.withheldThinkingTokens).toBe(250);
    expect(tb.calibratedNarrationTokens).toBe((tb.narrationTokens ?? 0) * 0.5);
    expect(tb.calibratedResidual).toBe(
      tb.reportedTokens - ((tb.calibratedMeasuredTokens ?? 0) + (tb.withheldThinkingTokens ?? 0)),
    );
  });

  it('a non-blank bearing response measures thinkingTokens for real and collapses withheldThinkingTokens toward zero (D1)', () => {
    const visibleThinkingText = 'Checking the auth path in detail.';
    const transcripts = new Map<string, TranscriptResponse[]>([
      [
        'sess-a',
        [
          tr({ messageId: 'free1', outputTokens: 100, visibleChars: 200, visibleText: 'x'.repeat(200) }),
          tr({
            messageId: 'bearing1',
            outputTokens: 100,
            thinkingBearing: true,
            visibleChars: 0,
            thinkingChars: visibleThinkingText.length, // NON-blank — real length, not 0
            // visibleText now (D6) carries the non-blank thinking text itself, since
            // bearingVisibleTokenized tokenizes it directly instead of a chars/ratio estimate.
            visibleText: visibleThinkingText,
          }),
        ],
      ],
    ]);
    const s = computeRunStats(
      'r',
      [
        at(1, 'session.started', { sessionId: 'sess-a', backend: 'claude' }),
        at(2, 'item.completed', { item: { kind: 'reasoning', id: 'r1', text: visibleThinkingText } }),
        at(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 200, total: 201 } }),
      ],
      transcripts,
      charTokenize,
    );
    const tb = s.steps[0]?.tokenBreakdown!;
    // tokenScaleFactor = 100/200 = 0.5; bearingVisibleTokenized = charTokenize(visibleThinkingText) = 34;
    // withheld = 100 - 34*0.5 = 83. Small next to the full 100 — collapsed toward zero because the
    // thinking was ACTUALLY visible and counted, via thinkingTokens, not treated as a separate
    // withheld cost on top of it.
    expect(tb.thinkingTokens).toBe(visibleThinkingText.length); // measured, real
    expect(tb.withheldThinkingTokens).toBeLessThan(tb.reportedTokens * 0.5);
  });

  it("a step whose own local free-response count is 0 still gets withheldThinkingTokens from the run-wide pool — ratio undefined, not NaN (N7)", () => {
    const transcripts = new Map<string, TranscriptResponse[]>([
      ['sess-a', [tr({ messageId: 'free1', outputTokens: 100, visibleChars: 200, visibleText: 'x'.repeat(200) })]],
      ['sess-b', [tr({ messageId: 'bearing1', outputTokens: 50, thinkingBearing: true, visibleChars: 0 })]],
    ]);
    const s = computeRunStats(
      'r',
      [
        at(1, 'session.started', { stepId: 'a', sessionId: 'sess-a', backend: 'claude' }),
        at(2, 'item.completed', { stepId: 'a', item: { kind: 'message', id: 'ma', role: 'assistant', text: 'x' } }),
        at(3, 'turn.completed', { stepId: 'a', turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 100, total: 101 } }),
        at(4, 'session.started', { stepId: 'b', sessionId: 'sess-b', backend: 'claude' }),
        at(5, 'item.completed', { stepId: 'b', item: { kind: 'message', id: 'mb', role: 'assistant', text: 'y' } }),
        at(6, 'turn.completed', { stepId: 'b', turnId: 't2', stopReason: 'end_turn', usage: { input: 1, output: 50, total: 51 } }),
      ] as unknown as RunEvent[],
      transcripts,
      charTokenize,
    );
    const b = s.steps.find((x) => x.stepId === 'b')?.tokenBreakdown!;
    expect(b.mode).toBe('calibrated');
    expect(b.calibration?.freeResponseCount).toBe(0);
    expect(b.calibration?.ratio).toBeUndefined();
    expect(b.calibration?.appliedRatio).toBe(2); // pooled from sess-a alone
    expect(b.calibration?.appliedScaleFactor).toBe(0.5); // 100/charTokenize('x'.repeat(200)) = 100/200
    expect(Number.isNaN(b.withheldThinkingTokens)).toBe(false);
  });

  it('falls every step back to basic mode when the run has zero thinking-free responses anywhere — never NaN (N4)', () => {
    const transcripts = new Map<string, TranscriptResponse[]>([
      ['sess-a', [tr({ messageId: 'm1', outputTokens: 50, thinkingBearing: true, visibleChars: 0 })]],
    ]);
    const s = computeRunStats(
      'r',
      [
        at(1, 'session.started', { sessionId: 'sess-a', backend: 'claude' }),
        at(2, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'hi' } }),
        at(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 50, total: 51 } }),
      ],
      transcripts,
      charTokenize,
    );
    const tb = s.steps[0]?.tokenBreakdown!;
    expect(tb.mode).toBe('basic');
    expect(tb.withheldThinkingTokens).toBeUndefined();
    expect(tb.calibration).toBeUndefined();
  });

  it('a step with no matching transcript falls back to basic mode even though the run-wide pool is non-empty', () => {
    const transcripts = new Map<string, TranscriptResponse[]>([
      ['sess-elsewhere', [tr({ messageId: 'm1', outputTokens: 100, visibleChars: 200, visibleText: 'x'.repeat(200) })]],
    ]);
    const s = computeRunStats(
      'r',
      [
        // No session.started for THIS step — its sessionIds set stays empty.
        at(1, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'hi' } }),
        at(2, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 50, total: 51 } }),
      ],
      transcripts,
      charTokenize,
    );
    expect(s.steps[0]?.tokenBreakdown?.mode).toBe('basic');
  });

  it('totals: mixed modes sum only where defined, count exclusions, and follow calibrated > basic > unavailable precedence (N5)', () => {
    const transcripts = new Map<string, TranscriptResponse[]>([
      ['sess-cal', [tr({ messageId: 'm1', outputTokens: 100, visibleChars: 200, visibleText: 'x'.repeat(200) })]],
    ]);
    const s = computeRunStats(
      'r',
      [
        at(1, 'session.started', { stepId: 'calibrated-step', sessionId: 'sess-cal', backend: 'claude' }),
        at(2, 'item.completed', { stepId: 'calibrated-step', item: { kind: 'message', id: 'm1', role: 'assistant', text: 'a' } }),
        at(3, 'turn.completed', {
          stepId: 'calibrated-step',
          turnId: 't1',
          stopReason: 'end_turn',
          usage: { input: 1, output: 100, total: 101 },
          blockCounts: { text: 1, thinking: 0, thinkingWithheld: 0, toolUse: 0, redactedThinking: 0, serverToolUse: 0, other: 0 },
        }),
        at(4, 'item.completed', { stepId: 'basic-step', item: { kind: 'message', id: 'm2', role: 'assistant', text: 'b' } }),
        at(5, 'turn.completed', { stepId: 'basic-step', turnId: 't2', stopReason: 'end_turn', usage: { input: 1, output: 20, total: 21 } }), // no blockCounts
      ],
      transcripts,
      charTokenize,
    );
    const totals = s.totals.tokenBreakdown!;
    expect(totals.mode).toBe('calibrated');
    expect(totals.stepsNotCalibrated).toBe(1); // basic-step
    expect(totals.stepsWithoutBlockCounts).toBe(1); // basic-step has no blockCounts
    expect(totals.reportedTokens).toBe(120);
    // Never a fabricated per-step-diagnostic average on totals (R9).
    expect(totals.freeGapPct).toBeUndefined();
    expect(totals.calibration).toBeUndefined();
  });

  it('formatRunStats prints the calibrated withheld line (inferred) and the calibration ratio line', () => {
    const transcripts = new Map<string, TranscriptResponse[]>([
      [
        'sess-a',
        [
          tr({ messageId: 'free1', outputTokens: 100, visibleChars: 200, visibleText: 'x'.repeat(200) }),
          tr({ messageId: 'bearing1', outputTokens: 300, thinkingBearing: true, visibleChars: 100, visibleText: 'y'.repeat(100) }),
        ],
      ],
    ]);
    const s = computeRunStats(
      'r',
      [
        at(1, 'session.started', { sessionId: 'sess-a', backend: 'claude' }),
        at(2, 'item.completed', { item: { kind: 'message', id: 'm1', role: 'assistant', text: 'a' } }),
        at(3, 'turn.completed', { turnId: 't1', stopReason: 'end_turn', usage: { input: 1, output: 400, total: 401 } }),
      ],
      transcripts,
      charTokenize,
    );
    const text = formatRunStats(s);
    expect(text).toContain('withheld thinking (inferred)');
    expect(text).toContain('calibration ratio');
    expect(text).toContain('calibrated narrate/think/tool-arg');
  });
});

/**
 * Real transcript PARSING (`parseTranscriptResponses`) — the piece that reads an actual Claude
 * Code `.jsonl` file's lines, groups them by `message.id`, and classifies each response. Pins
 * Implementation-critical rule #1 (R4): grouping is MANDATORY or usage over-counts (measured on
 * `70f19253`: 940,963 naive vs 375,001 deduped, 2.5×) — this is that dedup rule, unit-tested
 * directly against hand-authored transcript lines, no real file on disk.
 */
describe('parseTranscriptResponses — message.id dedup, sidechain exclusion, thinking classification', () => {
  function assistantLine(overrides: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [],
        usage: { output_tokens: 100 },
        ...(overrides.message as Record<string, unknown> | undefined),
      },
      ...overrides,
    });
  }

  it('dedupes a response split across multiple block-records sharing one message.id — never sums usage per record', () => {
    const lines = [
      assistantLine({ message: { id: 'msg_1', content: [{ type: 'text', text: 'Hello ' }], usage: { output_tokens: 417 } } }),
      assistantLine({ message: { id: 'msg_1', content: [{ type: 'tool_use', input: { command: 'ls' } }], usage: { output_tokens: 417 } } }),
    ];
    const responses = parseTranscriptResponses(lines);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.outputTokens).toBe(417); // NOT 834 — the dedup rule this test pins
    expect(responses[0]?.visibleChars).toBe('Hello '.length + JSON.stringify({ command: 'ls' }).length);
  });

  it('excludes isSidechain:true records — a sub-agent turn embedded inline is not this session’s own spend', () => {
    const lines = [
      assistantLine({ message: { id: 'msg_main', content: [{ type: 'text', text: 'main' }], usage: { output_tokens: 10 } } }),
      assistantLine({
        isSidechain: true,
        message: { id: 'msg_side', content: [{ type: 'text', text: 'sidechain' }], usage: { output_tokens: 999 } },
      }),
    ];
    const responses = parseTranscriptResponses(lines);
    expect(responses.map((r) => r.messageId)).toEqual(['msg_main']);
  });

  it('classifies thinking-bearing (blank or not) vs thinking-free, and folds non-blank thinking chars into thinkingChars only', () => {
    const lines = [
      assistantLine({ message: { id: 'free', content: [{ type: 'text', text: 'no thinking here' }], usage: { output_tokens: 10 } } }),
      assistantLine({
        message: {
          id: 'blank-bearing',
          content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'visible reply' }],
          usage: { output_tokens: 90 },
        },
      }),
      assistantLine({
        message: {
          id: 'visible-bearing',
          content: [{ type: 'thinking', thinking: 'Real reasoning text.' }],
          usage: { output_tokens: 40 },
        },
      }),
    ];
    const responses = parseTranscriptResponses(lines);
    const free = responses.find((r) => r.messageId === 'free')!;
    const blank = responses.find((r) => r.messageId === 'blank-bearing')!;
    const visible = responses.find((r) => r.messageId === 'visible-bearing')!;
    expect(free.thinkingBearing).toBe(false);
    expect(free.visibleText).toBe('no thinking here');
    expect(blank.thinkingBearing).toBe(true);
    expect(blank.thinkingChars).toBe(0); // blank — no visible thinking text
    expect(blank.visibleChars).toBe('visible reply'.length);
    // A blank thinking block contributes nothing to visibleText — only the real text block does.
    expect(blank.visibleText).toBe('visible reply');
    expect(visible.thinkingBearing).toBe(true);
    expect(visible.thinkingChars).toBe('Real reasoning text.'.length); // non-blank — real length
    // D6: non-blank thinking text is folded into visibleText too, since bearingVisibleTokenized
    // (Solution) tokenizes it directly instead of a chars/ratio estimate.
    expect(visible.visibleText).toBe('Real reasoning text.');
  });

  it('skips malformed lines and non-assistant records rather than throwing', () => {
    const lines = ['not json at all', JSON.stringify({ type: 'user', message: {} }), assistantLine({})];
    expect(() => parseTranscriptResponses(lines)).not.toThrow();
  });
});

/**
 * The reconciliation test (Phase 4) — computed against a COMMITTED, CI-safe fixture pair
 * (`core/__fixtures__/runs/token-breakdown-synthetic.*`), never against `70f19253` or any live
 * `~/.claude/projects/` transcript, using the real `gpt-tokenizer`. `computeRunStats` is called
 * directly with a hand-built `transcripts` map (D3) — the two `.jsonl` files are read and parsed
 * with `parseTranscriptResponses`, exactly what `readRunStats` would do, but never touching
 * `~/.claude/projects/` or `.ai/cezar/runs/` (both gitignored/this-box-only — the exact "eyeballed
 * once" failure an earlier revision of this spec's own review caught).
 *
 * **The fixture is an explicit INVERSION of `ec6e8e06-trimmed.ndjson`'s convention**
 * (`stats.test.ts:10-24`): that fixture strips `input`/text payloads and carries only v1
 * `tool-call`/`tool-result` events, no v2 `item.*` events at all — the one thing this test
 * tokenizes is exactly what that convention removes. `token-breakdown-synthetic.ndjson` retains
 * full text/JSON payloads and includes v2 `item.completed`/`turn.completed` events; its two
 * matching `.jsonl` files are synthetic Claude Code session transcripts, same shape a real one
 * has (`type: 'assistant'`, `message.id`, `message.usage.output_tokens`, content blocks).
 * Content proportions (tool-arg-heavy, narration-light, near-zero thinking) mirror `70f19253`'s
 * own run-wide split (narrationTokens 13.9k vs toolArgTokens 144.2k across that run).
 *
 * **The pooled free-response set is 8 responses (D8, this revision) — extended from the original
 * n=2 (`msg_free_1`, `msg_review_free_1`), which gave a parity split of n=1 train / n=1 holdout,
 * the exact single-response regime the hold-out test below forbids asserting on, and whose two
 * responses' near-identical implied ratios (1.585/1.575) made the split's error small BY
 * CONSTRUCTION of the fixture, not by virtue of the code under test.** The 6 new responses
 * (`msg_free_2..4` on `implement`, `msg_review_free_2..4` on `review-with-opaque`) give a
 * messageId-sorted parity split of 4 train / 4 holdout, and their `usage.output_tokens` are NOT
 * all proportional to tokenized visible length — `msg_free_4`/`msg_review_free_4` (very short
 * replies) carry a noticeably higher implied ratio (~3.3, vs ~1.6–2.1 for the rest), the same
 * per-response overhead real short Claude responses show. `implement`'s and `review-with-opaque`'s
 * `turn.completed.usage.output` were updated to match their (extended) transcript's own summed
 * `output_tokens`, same as before the extension.
 *
 * **The one-time TOLERANCE/HOLDOUT_TOLERANCE derivation this fixture's numbers were picked from
 * — real archived runs, real transcripts, real `gpt-tokenizer`, run once on this box, never itself
 * the assertion:**
 *
 * ```
 * 26 archived runs read via readRunStats() against their live ~/.claude/projects/ transcripts
 * (still present on this box at derivation time — 20 of 26 had at least one calibrated step)
 * freeGapPct (thinking-free-subset gap) across every calibrated step of every run: 29.3% – 61.4%
 * freeGapPct on 70f19253 alone (the reference run this spec's other numbers are drawn from),
 *   across its 8 steps: 34.7% – 38.9%
 * tokenScaleFactor hold-out prediction (messageId-sorted odd/even split) on 70f19253 alone (D7):
 *   tokenScaleFactor(train) = 1.5764, predicted holdout total 18,466 vs actual 18,282 —
 *   1.01% aggregate error (worst single-response error in the same split: 39%, hence the
 *   aggregate-only assertion below)
 * ```
 *
 * A 32-point run-wide `freeGapPct` spread is WIDE, not tight, confirming the spec's own chars/token
 * arithmetic prediction (Solution: "plausibly a 25–35% freeGapPct… not the single-digit-to-low-teens
 * figure a naive reading would suggest") — so Phase 4's WIDE branch applies: a stability/regression
 * band around the FIXTURE's own recorded `freeGapPct`, not an absolute-accuracy claim. `RECORDED_*`
 * below are this (D8-extended) fixture's own values, computed once and pinned; `STABILITY_BAND_PP`
 * catches a future change to the tokenizer, the JSON-serialization path, or the transcript-join
 * logic that silently shifts the number, without ever claiming the absolute figure is small.
 *
 * **`HOLDOUT_TOLERANCE` (D7) is the real, falsifiable criterion-3 test — NOT a bound on
 * `calibratedResidual`, which sums to ~0 by algebra at the run level and so cannot fail for a
 * measurement reason (see `TokenBreakdown.calibratedResidual`'s own doc).** This fixture's own
 * messageId-sorted even/odd split measures **~4.3% aggregate error** (even half trains, odd half
 * is predicted) — set alongside `70f19253`'s real-run **1.01%** above, `HOLDOUT_TOLERANCE = 10%`
 * comfortably bounds both while still failing hard on an actual regression (a broken tokenizer, a
 * changed JSON-serialization path, or a reversed free/bearing classification would push the error
 * far past 10%, not marginally past it).
 */
describe('the reconciliation test (Phase 4) — CI-safe fixture, real gpt-tokenizer, stability band', () => {
  const RECORDED_IMPLEMENT_FREE_GAP_PCT = 39.0;
  const RECORDED_REVIEW_FREE_GAP_PCT = 43.4;
  const STABILITY_BAND_PP = 2; // percentage points
  const HOLDOUT_TOLERANCE = 10; // percent — see the derivation in this describe block's own doc comment

  function loadNdjson(path: string): RunEvent[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunEvent);
  }

  const events = loadNdjson(join(fixtureDir, 'token-breakdown-synthetic.ndjson'));
  const transcripts = new Map<string, TranscriptResponse[]>([
    [
      'fix-11111111-1111-4111-8111-111111111111',
      parseTranscriptResponses(
        readFileSync(join(fixtureDir, 'token-breakdown-synthetic.fix-11111111-1111-4111-8111-111111111111.jsonl'), 'utf8').split('\n'),
      ),
    ],
    [
      'fix-22222222-2222-4222-8222-222222222222',
      parseTranscriptResponses(
        readFileSync(join(fixtureDir, 'token-breakdown-synthetic.fix-22222222-2222-4222-8222-222222222222.jsonl'), 'utf8').split('\n'),
      ),
    ],
  ]);
  // The real, shipped tokenizer — the same one `readRunStats` lazily imports in production.
  const stats = computeRunStats('token-breakdown-synthetic', events, transcripts, (text) => countTokens(text));

  function step(id: string): TokenBreakdown {
    const found = stats.steps.find((s) => s.stepId === id)?.tokenBreakdown;
    if (!found) throw new Error(`no tokenBreakdown for step "${id}"`);
    return found;
  }

  it('a thinking-free-subset gap (freeGapPct) stays within the stability band of its recorded value', () => {
    const implement = step('implement');
    expect(implement.mode).toBe('calibrated');
    expect(implement.freeGapPct).toBeDefined();
    expect(Math.abs(implement.freeGapPct! - RECORDED_IMPLEMENT_FREE_GAP_PCT)).toBeLessThanOrEqual(STABILITY_BAND_PP);

    const review = step('review-with-opaque');
    expect(review.freeGapPct).toBeDefined();
    expect(Math.abs(review.freeGapPct! - RECORDED_REVIEW_FREE_GAP_PCT)).toBeLessThanOrEqual(STABILITY_BAND_PP);
  });

  it('a thinking-bearing response reports withheldThinkingTokens (inferred) — never folded into freeGapPct', () => {
    const tb = step('implement');
    expect(tb.withheldThinkingTokens).toBeGreaterThan(0);
    // freeGapPct is computed over the FREE subset alone — the bearing response does not move it.
    expect(Math.abs(tb.freeGapPct! - RECORDED_IMPLEMENT_FREE_GAP_PCT)).toBeLessThanOrEqual(STABILITY_BAND_PP);
    expect(formatRunStats(stats)).toContain('withheld thinking (inferred)');
  });

  it('a step with opaqueBlocks > 0 reports a distinct, labeled line — never silently folded into freeGapPct or withheld', () => {
    const tb = step('review-with-opaque');
    expect(tb.opaqueBlocks).toBe(4); // 3 redacted_thinking + 1 server_tool_use, from this step's blockCounts
    expect(tb.withheldThinkingTokens).toBe(0); // this step dispatched no thinking-bearing response of its own
    const text = formatRunStats(stats);
    expect(text).toContain('review-with-opaque: 4 opaque block(s)');
  });

  it('the reconciliation identity holds exactly in calibrated mode — printer arithmetic, not a measurement-quality claim', () => {
    // D6/D7, corrected this revision: the identity's operands are the CALIBRATED fields, not the
    // raw narrationTokens/toolArgTokens/thinkingTokens — mixing a raw BPE count with a calibrated
    // inference in the same sum is the pre-D6 defect (see stats.ts's TokenBreakdown docs). The
    // identity closes exactly per step, by definition (calibratedResidual is declared precisely
    // to close it) — that is an arithmetic/printer check, not a measurement-quality claim; see
    // Verification §4/§5 for the real (falsifiable) hold-out test.
    for (const id of ['implement', 'review-with-opaque']) {
      const tb = step(id);
      const sum =
        (tb.calibratedNarrationTokens ?? 0) +
        (tb.calibratedToolArgTokens ?? 0) +
        (tb.calibratedThinkingTokens ?? 0) +
        (tb.withheldThinkingTokens ?? 0) +
        (tb.calibratedResidual ?? 0);
      expect(sum).toBeCloseTo(tb.reportedTokens, 6);
    }
  });

  /**
   * D7/D8, this revision — the real, falsifiable criterion-3 test: a genuine hold-out prediction
   * of `tokenScaleFactor`, not a bound on `calibratedResidual` (which closes to ~0 by algebra at
   * the run level and so cannot fail for a measurement reason — see `TokenBreakdown`'s own doc).
   * Partition the run's pooled free responses (across BOTH steps — tokenScaleFactor is run-wide,
   * Solution's "Why run-wide, not per step") into two disjoint halves, deterministically: sort by
   * `messageId` ascending, then split by parity of that sorted index. Fit `tokenScaleFactor` on
   * one half, predict the other half's billed total from its tokenized content, and assert the
   * aggregate — never per-response, since a single response's own error can be large even when the
   * aggregate is small (39% worst-case on `70f19253`'s own split, this describe block's doc
   * comment).
   */
  it("holds out half the run's pooled free responses and predicts the other half's billed total within HOLDOUT_TOLERANCE (D7/D8)", () => {
    const pooledFree = [...transcripts.values()]
      .flat()
      .filter((r) => !r.thinkingBearing)
      .sort((a, b) => (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0));
    // D8: at least 8 pooled free responses, at least 4 per half — the currently-committed fixture
    // meets this bar (8 total: msg_free_1..4, msg_review_free_1..4), giving a real train/holdout
    // aggregate rather than the n=1-vs-1 single-response regime this test forbids asserting on.
    expect(pooledFree.length).toBeGreaterThanOrEqual(8);

    const train = pooledFree.filter((_, i) => i % 2 === 0);
    const holdout = pooledFree.filter((_, i) => i % 2 === 1);
    expect(train.length).toBeGreaterThanOrEqual(4);
    expect(holdout.length).toBeGreaterThanOrEqual(4);

    const tokenizedOf = (r: TranscriptResponse): number => countTokens(r.visibleText);
    const trainTokens = train.reduce((acc, r) => acc + r.outputTokens, 0);
    const trainTokenized = train.reduce((acc, r) => acc + tokenizedOf(r), 0);
    const trainScaleFactor = trainTokens / trainTokenized;

    const holdoutTokenized = holdout.reduce((acc, r) => acc + tokenizedOf(r), 0);
    const holdoutActual = holdout.reduce((acc, r) => acc + r.outputTokens, 0);
    const predictedHoldoutTotal = trainScaleFactor * holdoutTokenized;

    // ~4.3% on this fixture, ~1.01% on 70f19253's real-run split (this describe block's doc
    // comment) — both comfortably inside HOLDOUT_TOLERANCE.
    const errorPct = (Math.abs(predictedHoldoutTotal - holdoutActual) / holdoutActual) * 100;
    expect(errorPct).toBeLessThanOrEqual(HOLDOUT_TOLERANCE);
  });
});

