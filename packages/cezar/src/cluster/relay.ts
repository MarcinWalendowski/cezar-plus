import { CLUSTER_FRAME_MAX_BYTES, CLUSTER_PROTOCOL, type ClusterRelayFrame } from '@loki-labs/better-cezar-contract';
import type { RunEvent, RunStore } from '../runs/store.ts';

/**
 * On-demand relay of a foreign run's live events (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D9 + "API contracts").
 *
 * **Run events are relayed, never replicated.** ~146 MB of run NDJSON across a single day's active
 * files, and one run can be 25.7 MB — replicating that would spend the link on bytes nobody is
 * looking at. So a spoke streams a run's events to the hub **only while at least one viewer is
 * subscribed to that run's topic**: the same demand-driven discipline `server/ws.ts` already
 * implements, where *"a topic's publisher starts when its subscriber count goes 0→1 and is stopped
 * at 1→0."* At terminal status the spoke ships a **bounded tail** — the last N events plus the
 * handoff markdown — so the hub's board can render a finished foreign run without ever holding the
 * firehose.
 *
 * **A foreign run never offers a local-machine affordance, and this file is where that is
 * enforced.** The hub runs hosted (`CEZ_REMOTE=1`) where `localHandoff` is already false; the
 * cluster must not become a way to smuggle "open in terminal" for a run on somebody else's host. So
 * `stripLocalAffordances` runs over every event before it leaves this node — absolute paths, worktree
 * locations, session handles, anything a viewer's machine could be induced to act on. Adding a field
 * that carries one is a security change, not a feature.
 *
 * **This module owns exactly one caller-facing contract: `startRelay`/`relayTail`/
 * `stripLocalAffordances`.** How the hub aggregates its own cockpit viewers into a single
 * `relay{subscribe}` request over the link, and how a spoke wires the resulting demand signal to
 * `startRelay`'s `send`, is `cluster/link-*.ts` territory (package 4.4 owns this file only). So
 * `startRelay` is written to be safe under either calling convention a caller might choose:
 * called once per distinct watcher (each with its own `send`) or once per link. Two independent
 * `startRelay` calls for the same `runId` never share state — each owns its own store listener,
 * its own queue and its own `truncated` carry — so one watcher's traffic, budget and teardown
 * can never be observed by another's `send`.
 */

/** Bounded tail at terminal status. Enough to render what happened, far short of the firehose. */
export const RELAY_TAIL_EVENTS = 200;

/**
 * Per-flush cap on how many queued events one `startRelay` subscription hands to `send` at once,
 * independent of `CLUSTER_FRAME_MAX_BYTES` (a burst of many *small* events would otherwise pass
 * the byte cap while still hogging the link for one node's backlog). A tick that still has queued
 * events after this cap reschedules itself rather than draining in one pass — the "per-tick send
 * budget" the spec bounds every transport by.
 */
export const RELAY_TICK_EVENT_BUDGET = 64;

export interface RelaySubscription {
  runId: string;
  /** Idempotent. Called at 1→0, and again on teardown. */
  stop(): void;
}

/** Rough envelope overhead (`type`/`protocol`/`runId`/`truncated`) added to the JSON size of the
 *  `events` array itself when sizing a batch against `CLUSTER_FRAME_MAX_BYTES`. */
const FRAME_ENVELOPE_BYTES = 128;

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Drains up to `RELAY_TICK_EVENT_BUDGET` events off the FRONT of `queue`, stopping early if the
 *  next event would push the batch over `CLUSTER_FRAME_MAX_BYTES`. Always takes at least one
 *  event when the queue is non-empty — a single oversized event is sent alone (and still counted
 *  against the byte cap by whatever wraps `send`) rather than wedging the queue forever. */
function drainBatch(queue: RunEvent[]): RunEvent[] {
  const batch: RunEvent[] = [];
  let bytes = FRAME_ENVELOPE_BYTES;
  while (queue.length > 0 && batch.length < RELAY_TICK_EVENT_BUDGET) {
    const size = jsonByteLength(queue[0]);
    if (batch.length > 0 && bytes + size > CLUSTER_FRAME_MAX_BYTES) break;
    bytes += size;
    batch.push(queue.shift() as RunEvent);
  }
  if (batch.length === 0 && queue.length > 0) {
    batch.push(queue.shift() as RunEvent);
  }
  return batch;
}

/**
 * Starts relaying while watched. `send` returning `false` (frame over
 * `CLUSTER_FRAME_MAX_BYTES`, or link offline) must set `truncated` on the next frame rather than
 * dropping silently: a gap the viewer cannot see is worse than a gap it can.
 *
 * A failed `send` does not retry its batch — those events are gone. What survives is the fact of
 * the gap: the next frame that *does* go out carries `truncated: true`, so the viewer can render
 * "some events were missed here" instead of a transcript that silently reads as complete.
 */
export function startRelay(
  store: RunStore,
  runId: string,
  send: (frame: ClusterRelayFrame) => boolean,
  options?: { now?: () => Date; warn?: (message: string) => void },
): RelaySubscription {
  const warn = options?.warn ?? (() => {});
  const now = options?.now ?? (() => new Date());

  let stopped = false;
  let flushScheduled = false;
  let truncatedPending = false;
  const queue: RunEvent[] = [];

  const scheduleFlush = () => {
    if (flushScheduled || stopped) return;
    flushScheduled = true;
    // `setImmediate`, not a fixed-delay timer: it yields to whatever else is already queued on
    // the event loop (other link frames among them) between ticks without depending on wall-clock
    // precision, so tests can drain it deterministically without fake timers.
    setImmediate(flush);
  };

  const flush = () => {
    flushScheduled = false;
    if (stopped || queue.length === 0) return;
    const batch = drainBatch(queue);
    const frame: ClusterRelayFrame = {
      type: 'relay',
      protocol: CLUSTER_PROTOCOL,
      runId,
      events: batch,
      ...(truncatedPending ? { truncated: true } : {}),
    };
    const delivered = send(frame);
    if (delivered) {
      truncatedPending = false;
    } else {
      truncatedPending = true;
      warn(
        `[${now().toISOString()}] cluster/relay: send failed for run ${runId} — ${batch.length} ` +
          'event(s) dropped, next frame will carry truncated: true',
      );
    }
    // More queued than this tick's budget carried — schedule the next tick rather than draining
    // it all now, so a run emitting far more events than the budget cannot starve other traffic
    // sharing the link.
    if (queue.length > 0 && !stopped) scheduleFlush();
  };

  const onEvent = (payload: { runId: string; event: RunEvent }) => {
    if (stopped || payload.runId !== runId) return;
    queue.push(stripLocalAffordances(payload.event) as unknown as RunEvent);
    scheduleFlush();
  };

  store.on('event', onEvent);

  return {
    runId,
    stop() {
      // Idempotent: the caller may call this once at 1→0 and again on teardown (its own doc
      // comment). A second call must be a no-op, not a double `store.off`/re-clear.
      if (stopped) return;
      stopped = true;
      store.off('event', onEvent);
      // Closing the view really stops the relay: nothing queued at stop time is worth sending to
      // a watcher who is no longer there, and — the property the negative control checks — no
      // further frames are sent afterward, because `onEvent` and `flush` both bail on `stopped`.
      queue.length = 0;
    },
  };
}

/** Shrinks `frame` until it fits `CLUSTER_FRAME_MAX_BYTES`, dropping the handoff markdown first
 *  (it can be up to 200 KB on its own) and then the oldest events (a tail cares about recency).
 *  Marks `truncated: true` the moment anything is actually dropped for size. */
function fitToFrameBudget(frame: ClusterRelayFrame): ClusterRelayFrame {
  if (jsonByteLength(frame) <= CLUSTER_FRAME_MAX_BYTES) return frame;
  let next: ClusterRelayFrame = { ...frame, truncated: true };
  if (next.handoffMarkdown !== undefined) {
    const { handoffMarkdown: _drop, ...rest } = next;
    next = rest;
    if (jsonByteLength(next) <= CLUSTER_FRAME_MAX_BYTES) return next;
  }
  const events = [...next.events];
  while (events.length > 0 && jsonByteLength({ ...next, events }) > CLUSTER_FRAME_MAX_BYTES) {
    events.shift();
  }
  return { ...next, events };
}

/** The terminal tail: the last `RELAY_TAIL_EVENTS` plus the handoff markdown, `final: true`. Sent
 *  once, whether or not anyone is watching — a finished foreign run has to be renderable later. */
export function relayTail(
  store: RunStore,
  runId: string,
  options?: { limit?: number },
): Promise<ClusterRelayFrame> {
  const limit = options?.limit ?? RELAY_TAIL_EVENTS;
  const events = store
    .readEvents(runId)
    .slice(-limit)
    .map((event) => stripLocalAffordances(event) as unknown as RunEvent);
  const handoffMarkdown = store.readHandoffText(runId) || undefined;
  const frame: ClusterRelayFrame = {
    type: 'relay',
    protocol: CLUSTER_PROTOCOL,
    runId,
    events,
    final: true,
    ...(handoffMarkdown !== undefined ? { handoffMarkdown } : {}),
  };
  return Promise.resolve(fitToFrameBudget(frame));
}

/**
 * Field names that are themselves a local-machine affordance, wherever they appear in the event
 * tree — the value is only ever meaningful ON the origin host (`workflows/run.ts`'s step state):
 * `sessionId` + `backend` is the exact pair "same-backend Continue" resumes a CLI session from,
 * `worktreePath`/`cwd`/`repoRoot` are filesystem locations, and `handoffPath` mirrors the literal
 * field name `handoff.ts`/`runs/store.ts` use for the per-run journal file. Dropped, not
 * redacted — the key itself is the affordance, there is no safe-to-keep partial value.
 */
const LOCAL_AFFORDANCE_KEYS = new Set([
  'worktreePath',
  'worktree',
  'cwd',
  'repoRoot',
  'sessionId',
  'backend',
  'profileId',
  'configDir',
  'handoffPath',
]);

/**
 * **This list is a DENYLIST, and a denylist on a security boundary fails open. Read the residual
 * before adding an event field.** (Assessed 2026-08-22; the author of this module flagged the gap
 * rather than letting it pass, which is why it is written down here instead of discovered later.)
 *
 * An allowlist would be the right shape — relay only fields a wire schema names — and it is not
 * available: `clusterRelayFrameSchema.events` is `z.array(z.record(z.string(), z.unknown()))` and
 * `RunEvent` is an interface with an `[key: string]: unknown` index signature, so neither the
 * contract nor the type enumerates what an event may carry. There is nothing to allow *from*. A
 * test cannot be generated from the type either, for the same reason. Inverting this is real work:
 * `RunEvent` has to stop being an index signature first.
 *
 * **What the residual actually is, which is narrower than "any missed key":** `stripDeep` walks
 * every string anywhere in the tree and runs `scrubLocalPaths` over it, so a filesystem path is
 * redacted whether or not its key is listed here. The exposure is therefore limited to an event
 * field carrying an **opaque resume handle** — a session id, a backend name, a profile id: values
 * that are not path-shaped and that let a viewer continue work on the origin machine. That is the
 * class to check for when adding a field, not paths.
 *
 * The module docblock's rule is the operative one and it is the cheap defence: **adding an event
 * field that carries a local affordance is a security change, not a feature.** It gets reviewed as
 * one, and it gets a key added here in the same change.
 */

/**
 * Absolute filesystem paths tied to a specific machine's home directory, the part of "absolute
 * paths" a key allowlist cannot catch — agent transcripts quote shell commands and tool
 * output/input verbatim, and either can carry a path inline. Deliberately narrow to recognizably
 * local roots (`/Users/…`, `/home/…`, `~/…`, a Windows drive letter, a WSL UNC root) rather than
 * every leading slash, so a route like `/api/v1/cluster` or a markdown heading survives untouched.
 */
const LOCAL_PATH_RE =
  /(?:\/Users\/[^\s'"]+|\/home\/[^\s'"]+|\/root\/[^\s'"]+|~\/[^\s'"]*|[A-Za-z]:\\[^\s'"]+|\\\\wsl\$\\[^\s'"]+)/g;

function scrubLocalPaths(text: string): string {
  return text.replace(LOCAL_PATH_RE, '[local path redacted]');
}

function stripDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubLocalPaths(value);
  if (Array.isArray(value)) return value.map(stripDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (LOCAL_AFFORDANCE_KEYS.has(key)) continue;
      out[key] = stripDeep(v);
    }
    return out;
  }
  return value;
}

/**
 * Removes anything that would let a viewer act on the ORIGIN machine — absolute paths, worktree
 * locations, session handles, local handoff targets. Applied to every event before it leaves this
 * node, so the rule holds regardless of which caller forgot.
 */
export function stripLocalAffordances(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return stripDeep(event) as Record<string, unknown>;
}
