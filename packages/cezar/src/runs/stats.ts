import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { RunEvent } from '@loki-labs/better-cezar-contract';

/**
 * Tool-economy metrics for a run, derived from its NDJSON transcript
 * (spec `.ai/specs/2026-08-20-agent-round-trip-batching-and-fanout.md`, Phase 1;
 * re-based on the v2 item stream by `.ai/specs/2026-08-21-sub-agent-fanout-adoption-and-attribution.md`,
 * Phases 1-2).
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
 * **Two things this meter got wrong for its first two days, and how they are fixed here.**
 *
 * 1. It counted a sub-agent dispatch by exact string equality with `'Task'`. Claude emits
 *    `'Agent'`; `"tool":"Task"` occurs zero times in every transcript on this box. Three separate
 *    runs dispatched three sub-agents each and every one of them was recorded as zero. The count
 *    now comes from the v2 item stream's `toolKind` (`core/tool-display.ts:144-155` normalises
 *    `Task` / `Agent` / opencode's `task` to the same kind), so it is spelling-proof and
 *    backend-agnostic — minus the `Skill` case, which `tool-display.ts:159-165` maps to that same
 *    `toolKind: 'task'` for display grouping and which is NOT fan-out.
 * 2. It billed a CHILD's tool calls to the PARENT's step, because `core/claude-cli-runner.ts`
 *    emits a v1 `tool-call` for every `tool_use` block with no parent filter and
 *    `workflows/run.ts` stamps `stepId` on all of them. On one measured run, 93 of a step's 106
 *    metered calls were made by sub-agents inside their own windows; the parent spent 13. So
 *    fan-out used to RAISE the round-trip count it was supposed to lower.
 *
 * Both fixes read events that were **already on disk** — no protocol widening, no change to any
 * runner. The join that makes it work: the v1 `tool-call.id` and the v2 `item.id` are the same
 * `toolu_…` string (measured: zero unmatched across four transcripts).
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
 * Fallback dispatch spellings, used ONLY for a call with no v2 item to read.
 *
 * Case-insensitive, and deliberately wider than the old `=== 'Task'`: claude says `Agent`,
 * opencode says `task`, older recordings say `Task`. This is what keeps a pre-v2 transcript
 * answering the question it was asked instead of silently reporting zero.
 */
const FALLBACK_DISPATCH_NAMES = new Set(['task', 'agent']);

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
  /**
   * UNCHANGED MEANING: every tool call stamped with this step — the parent's and its sub-agents'
   * alike. `ownToolCalls + childToolCalls`.
   */
  toolCalls: number;
  /**
   * Calls a sub-agent made inside its OWN context window (its v2 item carried `parentItemId`).
   *
   * Secondary metric: how much exploration the children absorbed on the parent's behalf. It is 0
   * for any transcript with no v2 `item.*` events, which is the correct degradation — an old log
   * cannot tell us who made a call, and guessing would be worse than saying nothing.
   */
  childToolCalls: number;
  /** `toolCalls - childToolCalls`. What THIS step's own agent actually spent in round trips. */
  ownToolCalls: number;
  /**
   * Assistant turns that issued ≥1 **own** tool call — see {@link computeRunStats} for how
   * they're counted. Children no longer split the parent's batch.
   */
  roundTrips: number;
  /** `ownToolCalls / roundTrips`, 2dp. **1.00 means no batching happened at all.** 0 when idle. */
  batchFactor: number;
  /**
   * Highest `context.updated.contextTokens` seen in this step — the parent agent's window only,
   * by construction: `core/claude-ui-mapper.ts` returns no main-agent token count for a subagent
   * frame, so a child's window never appears here.
   *
   * **`undefined`, never 0, when the step emitted no sample** — and that is a real case, not a
   * defensive one: run `7c2dd8f0`'s `spec` step has zero `context.updated` events while its later
   * steps have 72–294. Printing `0` there would read as "this step used no context", which is a
   * lie of exactly the kind this meter exists to remove.
   *
   * Each step is its own agent session with its own window, so peaks are PER-WINDOW and do not
   * compose: `RunStats.totals` takes the max across steps, never the sum.
   */
  peakContextTokens?: number;
  /**
   * Sub-agent DISPATCHES made by this step's own agent — v2 tool items with `toolKind === 'task'`
   * whose tool name is not `Skill` (see the module doc). 0 means the step never delegated.
   *
   * Attributed to the step on the **matching v1 `tool-call` event**, i.e. to the dispatching
   * parent. A nested dispatch made *by* a sub-agent is a child call and is never billed here.
   */
  subAgentCalls: number;
  /**
   * Σ(`tool-result`.ts − `tool-call`.ts) over this step's OWN calls.
   *
   * **This SUMS per-call durations**, so a step that dispatches three sub-agents in one turn
   * triple-counts that wall time. Pre-existing and not fixed here — but do not read it as elapsed
   * time on a fanned-out step. `wallMs` is the elapsed figure.
   */
  toolExecMs: number;
  /** Σ gaps `tool-result` → next `tool-call` in the same step, clamped to `[0, MAX_MODEL_GAP_MS)`.
   *  Own calls only: a child's result never opens or closes one of the parent's gaps. */
  modelMs: number;
  /** Own calls finishing in under a second… */
  cheapCalls: number;
  /** …and the work they actually did. A large `cheapCalls` against a tiny `cheapExecMs` is the
   *  round-trip tax the spec is about. */
  cheapExecMs: number;
}

/** Whole-run tool economy: the per-step rows plus their totals. */
export interface RunStats {
  runId: string;
  /** First → last event. Always ≥ the sum of step wall clocks (queueing, gaps between steps). */
  spanMs: number;
  steps: StepStats[];
  /** Summed across steps — **except `peakContextTokens`, which is the MAX**. `wallMs` is the SUM
   *  of step wall clocks, not the run span — those are different numbers and both are worth
   *  seeing (60.0 min vs 61.5 min on `ec6e8e06`). */
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

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function ratio(calls: number, roundTrips: number): number {
  return roundTrips === 0 ? 0 : Math.round((calls / roundTrips) * 100) / 100;
}

/** The v2 item payload this meter reads. Every field optional — it is parsed off disk. */
interface ToolItem {
  kind?: unknown;
  id?: unknown;
  name?: unknown;
  toolKind?: unknown;
  parentItemId?: unknown;
}

/**
 * The tool item on an `item.started` / `item.completed` event, or `undefined` for anything else
 * (message items, non-item events, malformed lines).
 *
 * Both lifecycle events are read even though `item.started` alone carries everything needed: they
 * describe the SAME id, so the sets are identical, and accepting both means a transcript trimmed
 * to completions still attributes correctly.
 */
function toolItemOf(event: RunEvent): ToolItem | undefined {
  if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
  const item = (event as { item?: unknown }).item;
  if (typeof item !== 'object' || item === null) return undefined;
  const candidate = item as ToolItem;
  return candidate.kind === 'tool' ? candidate : undefined;
}

/**
 * What the v2 item stream knows about a run's tool calls, keyed by the id the v1 stream uses too.
 *
 * All three sets are empty for a transcript with no `item.*` events — every pre-v2 recording, and
 * the `ec6e8e06` fixture. That is the degradation path, and it is exact: with `known` empty, every
 * call is "own", `roundTrips` and `batchFactor` are computed exactly as before, and `subAgentCalls`
 * falls back to a name match. Nothing about an old log's numbers moves.
 */
interface ItemIndex {
  /** Every tool item id seen. A call absent from here has no v2 record → fall back by name. */
  known: Set<string>;
  /** Items that ran inside a sub-agent's window. Their calls are the child's spend, not ours. */
  childIds: Set<string>;
  /** Items that ARE a dispatch: `toolKind: 'task'` minus the `Skill` case. */
  dispatchIds: Set<string>;
}

function indexToolItems(ordered: readonly RunEvent[]): ItemIndex {
  const index: ItemIndex = { known: new Set(), childIds: new Set(), dispatchIds: new Set() };
  for (const event of ordered) {
    const item = toolItemOf(event);
    if (!item) continue;
    const id = stringOf(item.id);
    if (id === undefined) continue;
    index.known.add(id);
    if (stringOf(item.parentItemId) !== undefined) index.childIds.add(id);
    // `Skill` shares `toolKind: 'task'` with a real dispatch (`tool-display.ts:159-165` groups the
    // two for display). Counting it would let a step pass a fan-out check by invoking a skill —
    // and `document`, the step this is measured on, is the one most likely to call one.
    if (item.toolKind === 'task' && stringOf(item.name)?.toLowerCase() !== 'skill') index.dispatchIds.add(id);
  }
  return index;
}

/**
 * The distinct `parentItemId` values in a transcript — every item id that fathered at least one
 * child item.
 *
 * **A cross-check, not the rule.** It identifies a dispatch structurally, so it is immune to both
 * tool spelling and the `Skill` collision for free; but it misses a dispatch whose sub-agent
 * produced no items, which is why {@link indexToolItems} keys on `toolKind` instead. The two
 * definitions agreed exactly (3 === 3) on both fanned-out transcripts, and a test pins that
 * agreement — so a future tool mapped to `toolKind: 'task'` surfaces as a failing test rather than
 * as a silently inflated metric.
 */
export function dispatchIdsByStructure(events: readonly RunEvent[]): Set<string> {
  const parents = new Set<string>();
  for (const event of events) {
    const item = (event as { item?: unknown }).item;
    if (typeof item !== 'object' || item === null) continue;
    const parentItemId = stringOf((item as ToolItem).parentItemId);
    if (parentItemId !== undefined) parents.add(parentItemId);
  }
  return parents;
}

interface Bucket {
  starts: number[];
  ends: number[];
  toolCalls: number;
  childToolCalls: number;
  roundTrips: number;
  toolExecMs: number;
  modelMs: number;
  cheapCalls: number;
  cheapExecMs: number;
  subAgentCalls: number;
  peakContextTokens?: number;
}

function emptyBucket(): Bucket {
  return {
    starts: [],
    ends: [],
    toolCalls: 0,
    childToolCalls: 0,
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
 * live in-memory tail or a file read back years later. The v2 item pre-pass runs over the whole
 * sorted array before any counting, so an item that lands after its own `tool-call` — or is only
 * ever seen as `item.completed` — still attributes correctly.
 *
 * **How a "round trip" is counted, and why it is a heuristic.** A run's NDJSON has no per-
 * assistant-message event: `turn.started` fires once per *step invocation* (10 times against 271
 * tool calls on `ec6e8e06`), so it cannot be used. What the transcript *does* preserve is order —
 * when a model emits several `tool_use` blocks in ONE turn, their `tool-call` events land back to
 * back with no `tool-result` between them. So a round trip is **a maximal run of consecutive OWN
 * `tool-call` events within one step**, and `batchFactor` is own calls ÷ those runs. The failure
 * mode is benign and in the conservative direction: a batch whose first result somehow interleaved
 * would be counted as two round trips, i.e. it would UNDER-report batching, never invent it.
 *
 * **Why children are skipped entirely rather than merely subtracted.** A sub-agent's calls and
 * results are interleaved with the parent's in one stream. Leaving the results in would clear the
 * open batch (a `tool-result` is what ends one), splitting a parent's single batched turn into as
 * many round trips as its children happened to interrupt — so the child's *results* must be
 * dropped along with its calls, or the fix undoes itself.
 */
export function computeRunStats(runId: string, events: readonly RunEvent[]): RunStats {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const items = indexToolItems(ordered);
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
  /** Was the previous OWN tool event in THIS step a call? If so, the next call joins its round trip. */
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
        const id = stringOf((event as { id?: unknown }).id);

        // A sub-agent's call, spending the CHILD's window. It is counted and then dropped: it
        // must not open a round trip, bill exec time, or claim a dispatch of its own.
        if (id !== undefined && items.childIds.has(id)) {
          bucket.childToolCalls += 1;
          break;
        }

        // A new round trip unless the immediately preceding own tool event was a call in this same
        // step — that is a second `tool_use` block riding along in one assistant turn.
        if (openBatchStep !== key) bucket.roundTrips += 1;
        openBatchStep = key;

        const tool = stringOf((event as { tool?: unknown }).tool);
        const dispatched =
          id !== undefined && items.known.has(id)
            ? items.dispatchIds.has(id)
            : FALLBACK_DISPATCH_NAMES.has((tool ?? '').toLowerCase());
        if (dispatched) bucket.subAgentCalls += 1;

        const since = lastResultAt.get(key);
        if (since !== undefined && ts !== undefined) {
          const gap = ts - since;
          if (gap >= 0 && gap < MAX_MODEL_GAP_MS) bucket.modelMs += gap;
        }
        if (id && ts !== undefined) pending.set(id, { stepId: key, startedAt: ts, tool });
        break;
      }
      case 'tool-result': {
        const id = stringOf((event as { toolCallId?: unknown }).toolCallId);
        // A child's result belongs to the child's turn. Letting it through here would close the
        // parent's open batch and inflate its round trips — see the doc comment above.
        if (id !== undefined && items.childIds.has(id)) break;
        const key = stepId ?? NO_STEP;
        openBatchStep = undefined;
        if (ts !== undefined) lastResultAt.set(key, ts);
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
      case 'context.updated': {
        const tokens = numberOf((event as { contextTokens?: unknown }).contextTokens);
        if (tokens === undefined) break;
        const bucket = bucketFor(stepId ?? NO_STEP);
        bucket.peakContextTokens = Math.max(bucket.peakContextTokens ?? 0, tokens);
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
    childToolCalls: b.childToolCalls,
    ownToolCalls: b.toolCalls - b.childToolCalls,
    roundTrips: b.roundTrips,
    batchFactor: ratio(b.toolCalls - b.childToolCalls, b.roundTrips),
    peakContextTokens: b.peakContextTokens,
    toolExecMs: b.toolExecMs,
    modelMs: b.modelMs,
    cheapCalls: b.cheapCalls,
    cheapExecMs: b.cheapExecMs,
    subAgentCalls: b.subAgentCalls,
  }));

  const sum = (pick: (s: StepStats) => number): number => steps.reduce((acc, s) => acc + pick(s), 0);
  const toolCalls = sum((s) => s.toolCalls);
  const childToolCalls = sum((s) => s.childToolCalls);
  const roundTrips = sum((s) => s.roundTrips);
  // MAX, not sum: every step is a separate agent session with its own window, so summing peaks
  // would invent a number no window ever held.
  const sampled = steps.map((s) => s.peakContextTokens).filter((v): v is number => v !== undefined);

  return {
    runId,
    spanMs: firstTs !== undefined && lastTs !== undefined ? Math.max(0, lastTs - firstTs) : 0,
    steps,
    totals: {
      wallMs: sum((s) => s.wallMs),
      toolCalls,
      childToolCalls,
      ownToolCalls: toolCalls - childToolCalls,
      roundTrips,
      batchFactor: ratio(toolCalls - childToolCalls, roundTrips),
      peakContextTokens: sampled.length > 0 ? Math.max(...sampled) : undefined,
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

/** Thousands of tokens, or an em dash for a step that never emitted a sample. Never `0.0`. */
function ktok(tokens: number | undefined): string {
  return tokens === undefined ? '—' : (tokens / 1_000).toFixed(1);
}

function pad(value: string, width: number, right = true): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

/**
 * The human table — the same shape as the per-step table in the spec's Problem section, so a
 * before/after pair can be read side by side without arithmetic.
 *
 * `calls` is the step's OWN calls, with the children's beside it in `child`, so the row reads as
 * what this step's agent spent. `ctx k` is peak context in thousands of tokens; on the TOTAL row
 * it is the max across steps, not a sum (see {@link RunStats.totals}).
 */
export function formatRunStats(stats: RunStats): string {
  const header = [
    pad('step', 16, false),
    pad('calls', 6),
    pad('child', 6),
    pad('trips', 6),
    pad('batch', 6),
    pad('model s', 9),
    pad('exec s', 9),
    pad('wall s', 9),
    pad('cheap', 6),
    pad('cheap s', 8),
    pad('sub', 4),
    pad('ctx k', 8),
  ].join('');

  const row = (label: string, s: Omit<StepStats, 'stepId' | 'restarts'>, restarts = 0): string =>
    [
      pad(restarts > 0 ? `${label} (×${restarts + 1})` : label, 16, false),
      pad(String(s.ownToolCalls), 6),
      pad(String(s.childToolCalls), 6),
      pad(String(s.roundTrips), 6),
      pad(s.batchFactor.toFixed(2), 6),
      pad(secs(s.modelMs), 9),
      pad(secs(s.toolExecMs), 9),
      pad(secs(s.wallMs), 9),
      pad(String(s.cheapCalls), 6),
      pad(secs(s.cheapExecMs), 8),
      pad(String(s.subAgentCalls), 4),
      pad(ktok(s.peakContextTokens), 8),
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
    // Fan-out's whole point: the exploration output stayed in the child's window, not the parent's.
    `${stats.totals.childToolCalls} of ${stats.totals.toolCalls} calls were made by sub-agents` +
      ` · peak context ` +
      (stats.totals.peakContextTokens === undefined
        ? 'not sampled by this run'
        : `${ktok(stats.totals.peakContextTokens)}k (max over steps, never a sum)`),
  ];
  return lines.join('\n');
}
