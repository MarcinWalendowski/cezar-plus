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
  };
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
  const pending = new Map<string, { stepId: string; startedAt: number; tool: string | undefined }>();
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
        if (stringOf((event as { tool?: unknown }).tool) === 'Task') bucket.subAgentCalls += 1;

        const since = lastResultAt.get(key);
        if (since !== undefined && ts !== undefined) {
          const gap = ts - since;
          if (gap >= 0 && gap < MAX_MODEL_GAP_MS) bucket.modelMs += gap;
        }
        const id = stringOf((event as { id?: unknown }).id);
        if (id && ts !== undefined) {
          pending.set(id, { stepId: key, startedAt: ts, tool: stringOf((event as { tool?: unknown }).tool) });
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
        bucket.toolExecMs += execMs;
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
  ];
  return lines.join('\n');
}
