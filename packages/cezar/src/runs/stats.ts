import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { RunEvent } from '@loki-labs/better-cezar-contract';

/**
 * Tool-economy metrics for a run, derived from its NDJSON transcript
 * (spec `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 1).
 *
 * **This module is the METER, and it ships before the optimisations it exists to judge.** The
 * repo's own standing rule is that decisions come from measured numbers; without this, every
 * later phase of that spec is an assertion. Nothing here changes agent behaviour.
 *
 * Everything is computed on demand from the NDJSON and **nothing is persisted** — no field is
 * added to `runs.json`, so `runs/store.ts` and the contract-parity tests do not move. The event
 * log is an append-only on-disk format (`BACKWARD_COMPATIBILITY.md` §7), which is exactly what
 * makes it safe to replay an old recording with new arithmetic.
 *
 * **`sleepCalls` / `blindSleepCalls` / `sleepExecMs` / `repeatedExpensiveCalls` were added on
 * 2026-08-21** (spec `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md`) and are the first
 * counters here that read a tool call's `input`. They exist so the two claims that spec makes are
 * falsifiable rather than asserted: that agents stopped guessing a duration, and that they stopped
 * re-running an expensive command to see a different slice of its output. Replayed against the
 * transcripts on the production box, they reproduce that spec's Problem table exactly —
 * `7c2dd8f0` → sleep 18, blind 4, 13.4 min, re-run 18.
 */

/** A tool call shorter than this counts as "cheap": it did no real work, it only cost a turn. */
const CHEAP_CALL_MS = 1_000;

/**
 * Gaps longer than this are not the model thinking — they are a step parked at `waiting`, a
 * queued run, or a restart. Counting them as model time would make an idle overnight run look
 * like the slowest reasoning in history.
 */
const MAX_MODEL_GAP_MS = 600_000;

/** Key used for tool calls that carry no `stepId` (none do today; a malformed log could). */
const NO_STEP = '(no step)';

/**
 * A first invocation slower than this is "expensive": re-running it only to see a different slice
 * of the same output is measurable waste. The floor keeps `git status` and friends out of it.
 */
const EXPENSIVE_CALL_MS = 5_000;

/**
 * An early-exit guard. A poll loop that sleeps between probes and breaks when the job finishes is
 * the CORRECT pattern — 32 of the 39 sleeps measured across five runs — so the defect counter has
 * to be able to tell it apart from a guessed duration.
 */
const SLEEP_GUARD = /\b(until|while|for)\b/;

/** `sleep <n>`, capturing the duration so `sleep 0` (which waits for nothing) can be dropped. */
const SLEEP_N = /\bsleep\s+([\d.]+)/g;

/**
 * The expensive verbs of this repo's toolchain. An allowlist, deliberately: it under-reports on a
 * stack that invokes its tests some other way rather than inventing hits on an unknown one.
 */
const COSTLY_INVOCATION =
  /(^|[;&|(\s])(npx\s+vitest|npx\s+tsc|vitest\s+run|npm\s+(run\s+\S+|test|ci|install)|pnpm\s+\S+|tools\/(typecheck|lint|test))\b/;

/**
 * Drop heredoc BODIES before reading a command.
 *
 * Measured necessity, in both directions. A `sleep 25` being *written into a script file* waits
 * for nothing, and counting it over-reports (`7c2dd8f0` wrote a timing experiment that way). But
 * stripping alone is net-zero: English prose inside a python heredoc ("…for the Wave A gate") was
 * acting as the `for` guard on a different call, so removing it correctly exposed a `sleep 0` that
 * is not a wait either. Stripping AND requiring a positive duration is what lands on the 7 genuine
 * blind waits; either one alone finds 8, and not the same 8.
 *
 * Only the closing tag alone on its own line ends a body, which is also how the shell reads it.
 */
function stripHeredocs(command: string): string {
  const kept: string[] = [];
  let terminator: string | null = null;
  for (const line of command.split('\n')) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const opened = line.match(/<<-?\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))\s*$/);
    if (opened) terminator = opened[1] ?? opened[2] ?? opened[3] ?? null;
  }
  return kept.join('\n');
}

/** What a Bash command tells us about waiting and about repetition. */
interface CommandSignals {
  isSleep: boolean;
  isBlindSleep: boolean;
  /** The costly invocation lines with their output filters removed, or '' if the call is cheap. */
  expensiveKey: string;
}

/**
 * **Both predicates are crude on purpose, and their failure directions are documented rather than
 * hidden** (spec `.ai/specs/2026-08-21-wait-on-the-process-not-a-guess.md` § Data models):
 *
 * - False "guarded": `for f in a b c; do …; done; sleep 60` — an unrelated loop and a blind sleep
 *   in one batch. This one UNDER-reports, so read the command list, not only the count.
 * - False "blind": a sleep bounded by `timeout` or a `trap`. Over-reports; errs toward flagging.
 * - Neither can separate overshoot from the real duration of the job waited for. Nothing in the
 *   NDJSON can.
 */
function signalsOf(command: string): CommandSignals {
  const text = stripHeredocs(command);
  const isSleep = [...text.matchAll(SLEEP_N)].some((m) => Number.parseFloat(m[1] ?? '0') > 0);
  const costly = text
    .split('\n')
    .filter((line) => COSTLY_INVOCATION.test(line))
    // The defect is the SAME command with a DIFFERENT filter, so the filter is what the key drops.
    // An exact-string key measures zero on every real run — that is how rev 1 of the spec would
    // have shipped a permanently-zero metric.
    .map((line) => (line.split(/[|>]/)[0] ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return {
    isSleep,
    isBlindSleep: isSleep && !SLEEP_GUARD.test(text),
    expensiveKey: costly.join(' ; '),
  };
}

function commandOf(event: RunEvent): string {
  const input = (event as { input?: unknown }).input;
  if (typeof input !== 'object' || input === null) return '';
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : '';
}

/** Per-step tool-economy metrics, derived from a run's NDJSON. */
export interface StepStats {
  stepId: string;
  /**
   * First `step-start` → last `step-end`.
   *
   * **A restarted step has more than one start** — take the first and the last, never a keyed
   * overwrite. Run `ec6e8e06`'s `spec` step emitted `step-start` twice (13:22:03 and 13:28:12)
   * when its worktree was deleted under it; keying by `stepId` reports that step as 134 s instead
   * of its real 503 s, which is a 4× understatement of the single slowest step in the run. The
   * fixture test pins exactly this.
   */
  wallMs: number;
  /** Extra `step-start` events beyond the first. 0 for a step that ran once. */
  restarts: number;
  toolCalls: number;
  /** Assistant turns that issued ≥1 tool call — see {@link computeRunStats} for how they're counted. */
  roundTrips: number;
  /** `toolCalls / roundTrips`, 2dp. **1.00 means no batching happened at all.** 0 when idle. */
  batchFactor: number;
  /** Σ(`tool-result`.ts − `tool-call`.ts). */
  toolExecMs: number;
  /** Σ gaps `tool-result` → next `tool-call` in the same step, clamped to `[0, MAX_MODEL_GAP_MS)`. */
  modelMs: number;
  /** Calls finishing in under a second… */
  cheapCalls: number;
  /** …and the work they actually did. A large `cheapCalls` against a tiny `cheapExecMs` is the
   *  round-trip tax the spec is about. */
  cheapExecMs: number;
  /** `Task` calls — sub-agent fan-out. 0 means the step never delegated. */
  subAgentCalls: number;
  /**
   * Bash calls whose command contains a real `sleep <n>`.
   *
   * **NOT a defect count.** A bounded poll loop legitimately sleeps between probes and exits when
   * the job does; its wall clock is mostly the job. This number may stay non-zero forever.
   */
  sleepCalls: number;
  /**
   * …of which the command carries NO early-exit guard — a guessed duration.
   *
   * **This is the defect.** Target: 0. `sleep 120; tail -12 /tmp/full-suite-mine.log` is the
   * archetype: the agent started something, did not know when it would finish, and guessed.
   */
  blindSleepCalls: number;
  /**
   * Σ exec ms of the `sleepCalls` **that have a matched `tool-result`** — necessarily a smaller
   * set than `sleepCalls`, because exec time needs both events and a wait that never returned has
   * only one. (On `7c2dd8f0`, 16 of 18.) Read it as an upper bound on waiting, not as waste.
   */
  sleepExecMs: number;
  /**
   * Repeat invocations of an expensive command (first run ≥ 5 s) — calls that re-ran work already
   * done, typically only to see a different slice of the same output.
   *
   * **A read-the-list signal, not a gate.** It cannot tell a wasteful re-slice from a legitimate
   * re-run after an edit, and says so rather than pretending to.
   */
  repeatedExpensiveCalls: number;
}

/** Whole-run tool economy: the per-step rows plus their totals. */
export interface RunStats {
  runId: string;
  /** First → last event. Always ≥ the sum of step wall clocks (queueing, gaps between steps). */
  spanMs: number;
  steps: StepStats[];
  /** Summed across steps. `wallMs` is the SUM of step wall clocks, not the run span — those are
   *  different numbers and both are worth seeing (60.0 min vs 61.5 min on `ec6e8e06`). */
  totals: Omit<StepStats, 'stepId' | 'restarts'>;
}

function msOf(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const value = Date.parse(ts);
  return Number.isFinite(value) ? value : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function ratio(calls: number, roundTrips: number): number {
  return roundTrips === 0 ? 0 : Math.round((calls / roundTrips) * 100) / 100;
}

interface Bucket {
  starts: number[];
  ends: number[];
  toolCalls: number;
  roundTrips: number;
  toolExecMs: number;
  modelMs: number;
  cheapCalls: number;
  cheapExecMs: number;
  subAgentCalls: number;
  sleepCalls: number;
  blindSleepCalls: number;
  sleepExecMs: number;
  /** Every expensive invocation this step made, in order — grouped into repeats after the replay,
   *  because whether a group counts depends on how long its FIRST call took. */
  expensive: Array<{ key: string; callId: string | undefined }>;
}

function emptyBucket(): Bucket {
  return {
    starts: [],
    ends: [],
    toolCalls: 0,
    roundTrips: 0,
    toolExecMs: 0,
    modelMs: 0,
    cheapCalls: 0,
    cheapExecMs: 0,
    subAgentCalls: 0,
    sleepCalls: 0,
    blindSleepCalls: 0,
    sleepExecMs: 0,
    expensive: [],
  };
}

/**
 * Repeats of an expensive invocation, counted per step.
 *
 * First-call-only on the 5 s test: a command that is cheap the first time and slow later is not
 * this defect. A group whose first call has no recorded result is skipped rather than guessed at —
 * under-reporting, in the same direction as every other unknown here.
 */
function countRepeatedExpensive(
  entries: ReadonlyArray<{ key: string; callId: string | undefined }>,
  execById: ReadonlyMap<string, number>,
): number {
  const groups = new Map<string, Array<string | undefined>>();
  for (const entry of entries) {
    const existing = groups.get(entry.key);
    if (existing) existing.push(entry.callId);
    else groups.set(entry.key, [entry.callId]);
  }
  let repeated = 0;
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const firstId = ids[0];
    const firstExecMs = firstId === undefined ? undefined : execById.get(firstId);
    if (firstExecMs === undefined || firstExecMs < EXPENSIVE_CALL_MS) continue;
    repeated += ids.length - 1;
  }
  return repeated;
}

/**
 * Replay a run's events into per-step tool-economy metrics.
 *
 * Pure and order-independent at the input (events are sorted by `seq` first), so it can be fed a
 * live in-memory tail or a file read back years later.
 *
 * **How a "round trip" is counted, and why it is a heuristic.** A run's NDJSON has no per-
 * assistant-message event: `turn.started` fires once per *step invocation* (10 times against 271
 * tool calls on `ec6e8e06`), so it cannot be used. What the transcript *does* preserve is order —
 * when a model emits several `tool_use` blocks in ONE turn, their `tool-call` events land back to
 * back with no `tool-result` between them. So a round trip is **a maximal run of consecutive
 * `tool-call` events within one step**, and `batchFactor` is calls ÷ those runs. The failure mode
 * is benign and in the conservative direction: a batch whose first result somehow interleaved
 * would be counted as two round trips, i.e. it would UNDER-report batching, never invent it.
 */
export function computeRunStats(runId: string, events: readonly RunEvent[]): RunStats {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const buckets = new Map<string, Bucket>();
  const bucketFor = (stepId: string): Bucket => {
    const existing = buckets.get(stepId);
    if (existing) return existing;
    const created = emptyBucket();
    buckets.set(stepId, created);
    return created;
  };

  /** `tool-call` id → its start time + owning step, so a result can be matched back to it. */
  const pending = new Map<
    string,
    { stepId: string; startedAt: number; tool: string | undefined; isSleep: boolean }
  >();
  /** `tool-call` id → measured exec ms. Kept after the pair is matched, because
   *  `repeatedExpensiveCalls` needs the FIRST call of a group long after that call closed. */
  const execById = new Map<string, number>();
  /** Last `tool-result` timestamp per step — the left edge of the next model gap. */
  const lastResultAt = new Map<string, number>();
  /** Was the previous tool event in THIS step a call? If so, the next call joins its round trip. */
  let openBatchStep: string | undefined;

  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const event of ordered) {
    const ts = msOf(event.ts);
    if (ts !== undefined) {
      if (firstTs === undefined) firstTs = ts;
      lastTs = ts;
    }
    const stepId = stringOf(event.stepId);

    switch (event.type) {
      case 'step-start': {
        if (stepId && ts !== undefined) bucketFor(stepId).starts.push(ts);
        break;
      }
      case 'step-end': {
        if (stepId && ts !== undefined) bucketFor(stepId).ends.push(ts);
        break;
      }
      case 'tool-call': {
        const key = stepId ?? NO_STEP;
        const bucket = bucketFor(key);
        bucket.toolCalls += 1;
        // A new round trip unless the immediately preceding tool event was a call in this same
        // step — that is a second `tool_use` block riding along in one assistant turn.
        if (openBatchStep !== key) bucket.roundTrips += 1;
        openBatchStep = key;
        const tool = stringOf((event as { tool?: unknown }).tool);
        if (tool === 'Task') bucket.subAgentCalls += 1;

        // The waiting and repetition meters read the COMMAND, which every other counter here
        // ignores. `input` has always been persisted on `tool-call`; this is the first thing to
        // read it. Bash only — a `sleep` inside a Read is not a thing.
        const signals = tool === 'Bash' ? signalsOf(commandOf(event)) : undefined;
        if (signals?.isSleep) bucket.sleepCalls += 1;
        if (signals?.isBlindSleep) bucket.blindSleepCalls += 1;

        const since = lastResultAt.get(key);
        if (since !== undefined && ts !== undefined) {
          const gap = ts - since;
          if (gap >= 0 && gap < MAX_MODEL_GAP_MS) bucket.modelMs += gap;
        }
        const id = stringOf((event as { id?: unknown }).id);
        if (signals?.expensiveKey) bucket.expensive.push({ key: signals.expensiveKey, callId: id });
        if (id && ts !== undefined) {
          pending.set(id, { stepId: key, startedAt: ts, tool, isSleep: signals?.isSleep ?? false });
        }
        break;
      }
      case 'tool-result': {
        const key = stepId ?? NO_STEP;
        openBatchStep = undefined;
        if (ts !== undefined) lastResultAt.set(key, ts);
        const id = stringOf((event as { toolCallId?: unknown }).toolCallId);
        if (id === undefined || ts === undefined) break;
        const call = pending.get(id);
        if (!call) break;
        pending.delete(id);
        const bucket = bucketFor(call.stepId);
        const execMs = Math.max(0, ts - call.startedAt);
        execById.set(id, execMs);
        bucket.toolExecMs += execMs;
        if (call.isSleep) bucket.sleepExecMs += execMs;
        if (execMs < CHEAP_CALL_MS) {
          bucket.cheapCalls += 1;
          bucket.cheapExecMs += execMs;
        }
        break;
      }
      default:
        break;
    }
  }

  const steps: StepStats[] = [...buckets.entries()].map(([stepId, b]) => ({
    stepId,
    wallMs: b.starts.length > 0 && b.ends.length > 0 ? Math.max(0, Math.max(...b.ends) - Math.min(...b.starts)) : 0,
    restarts: Math.max(0, b.starts.length - 1),
    toolCalls: b.toolCalls,
    roundTrips: b.roundTrips,
    batchFactor: ratio(b.toolCalls, b.roundTrips),
    toolExecMs: b.toolExecMs,
    modelMs: b.modelMs,
    cheapCalls: b.cheapCalls,
    cheapExecMs: b.cheapExecMs,
    subAgentCalls: b.subAgentCalls,
    sleepCalls: b.sleepCalls,
    blindSleepCalls: b.blindSleepCalls,
    sleepExecMs: b.sleepExecMs,
    repeatedExpensiveCalls: countRepeatedExpensive(b.expensive, execById),
  }));

  const sum = (pick: (s: StepStats) => number): number => steps.reduce((acc, s) => acc + pick(s), 0);
  const toolCalls = sum((s) => s.toolCalls);
  const roundTrips = sum((s) => s.roundTrips);

  return {
    runId,
    spanMs: firstTs !== undefined && lastTs !== undefined ? Math.max(0, lastTs - firstTs) : 0,
    steps,
    totals: {
      wallMs: sum((s) => s.wallMs),
      toolCalls,
      roundTrips,
      batchFactor: ratio(toolCalls, roundTrips),
      toolExecMs: sum((s) => s.toolExecMs),
      modelMs: sum((s) => s.modelMs),
      cheapCalls: sum((s) => s.cheapCalls),
      cheapExecMs: sum((s) => s.cheapExecMs),
      subAgentCalls: sum((s) => s.subAgentCalls),
      sleepCalls: sum((s) => s.sleepCalls),
      blindSleepCalls: sum((s) => s.blindSleepCalls),
      sleepExecMs: sum((s) => s.sleepExecMs),
      repeatedExpensiveCalls: sum((s) => s.repeatedExpensiveCalls),
    },
  };
}

/**
 * Read one run's NDJSON off disk and meter it. Streams line by line rather than
 * `readFileSync` + `split` — a busy run's log is megabytes (`ec6e8e06` is 2.4 MB / 2 004 events)
 * and this is the same reason `runs/event-history.ts` streams.
 *
 * Malformed lines are skipped, not fatal: a log truncated mid-write by a killed process is a
 * normal thing to want stats for.
 */
export async function readRunStats(ndjsonPath: string, runId: string): Promise<RunStats> {
  const events: RunEvent[] = [];
  const lines = createInterface({ input: createReadStream(ndjsonPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as Partial<RunEvent>;
      if (typeof value.seq === 'number' && typeof value.type === 'string' && typeof value.ts === 'string') {
        events.push(value as RunEvent);
      }
    } catch {
      // Truncated or corrupt line — skip it, keep metering the rest.
    }
  }
  return computeRunStats(runId, events);
}

function secs(ms: number): string {
  return (ms / 1_000).toFixed(1);
}

function pad(value: string, width: number, right = true): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

/**
 * The human table — the same shape as the per-step table in the spec's Problem section, so a
 * before/after pair can be read side by side without arithmetic.
 */
export function formatRunStats(stats: RunStats): string {
  const header = [
    pad('step', 16, false),
    pad('calls', 6),
    pad('trips', 6),
    pad('batch', 6),
    pad('model s', 9),
    pad('exec s', 9),
    pad('wall s', 9),
    pad('cheap', 6),
    pad('cheap s', 8),
    pad('sub', 4),
    // `blind/total`, in one cell: the defect number is useless without the legitimate one beside
    // it, since a bounded poll loop is supposed to show up here.
    pad('sleep', 8),
    pad('re-run', 7),
  ].join('');

  const row = (label: string, s: Omit<StepStats, 'stepId' | 'restarts'>, restarts = 0): string =>
    [
      pad(restarts > 0 ? `${label} (×${restarts + 1})` : label, 16, false),
      pad(String(s.toolCalls), 6),
      pad(String(s.roundTrips), 6),
      pad(s.batchFactor.toFixed(2), 6),
      pad(secs(s.modelMs), 9),
      pad(secs(s.toolExecMs), 9),
      pad(secs(s.wallMs), 9),
      pad(String(s.cheapCalls), 6),
      pad(secs(s.cheapExecMs), 8),
      pad(String(s.subAgentCalls), 4),
      pad(`${s.blindSleepCalls}/${s.sleepCalls}`, 8),
      pad(String(s.repeatedExpensiveCalls), 7),
    ].join('');

  const lines = [
    `run ${stats.runId} — span ${secs(stats.spanMs)}s`,
    '',
    header,
    '-'.repeat(header.length),
    ...stats.steps.map((s) => row(s.stepId, s, s.restarts)),
    '-'.repeat(header.length),
    row('TOTAL', stats.totals),
    '',
    // The two numbers the spec is actually about, spelled out rather than left to be derived.
    `batch factor ${stats.totals.batchFactor.toFixed(2)} calls/round-trip` +
      (stats.totals.batchFactor > 0 && stats.totals.batchFactor < 1.05 ? '  (1.00 = never batched)' : ''),
    `model:exec ${stats.totals.toolExecMs > 0 ? (stats.totals.modelMs / stats.totals.toolExecMs).toFixed(1) : '—'}×` +
      ` · ${stats.totals.cheapCalls} cheap calls did ${secs(stats.totals.cheapExecMs)}s of work` +
      ` · ${stats.totals.subAgentCalls} sub-agent call(s)`,
    // Spelled out because both numbers are crude and neither should be read as a verdict on its
    // own: the target is `blind 0`, and `re-run` is a prompt to go read the commands.
    `sleep ${stats.totals.blindSleepCalls} blind of ${stats.totals.sleepCalls}` +
      ` (${secs(stats.totals.sleepExecMs)}s waited)` +
      (stats.totals.blindSleepCalls > 0 ? '  (blind = a guessed duration; target 0)' : '') +
      ` · ${stats.totals.repeatedExpensiveCalls} expensive call(s) re-run`,
  ];
  return lines.join('\n');
}
