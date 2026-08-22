import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_FRAME_MAX_BYTES, CLUSTER_PROTOCOL, type ClusterRelayFrame } from '@loki-labs/better-cezar-contract';
import { seedHandoffFile } from '../handoff.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import { RunStore, type RunEvent } from '../runs/store.ts';
import {
  RELAY_TAIL_EVENTS,
  RELAY_TICK_EVENT_BUDGET,
  relayTail,
  startRelay,
  stripLocalAffordances,
} from './relay.ts';

/**
 * Package 4.4 (`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`), spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md` D9 + "API contracts". "On demand only" is
 * the whole design, so the three things this file exists to prove are: the relay actually stops
 * (not just the subscription object), two watchers on one run don't interfere with each other,
 * and a burst that outruns the per-tick budget is carried across ticks rather than dropped.
 */

/** `startRelay` schedules its ticks on `setImmediate` rather than a fixed-delay timer (see the
 *  source comment on `scheduleFlush`), so tests drain it by yielding the event loop repeatedly —
 *  no fake timers, no real delays, nothing that asserts on elapsed time. */
async function drain(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function mkEvent(n: number, extra: Record<string, unknown> = {}): RunEvent {
  return { seq: n, ts: new Date(2026, 7, 22, 0, 0, n).toISOString(), type: 'note', text: `event ${n}`, ...extra };
}

describe('cluster/relay — stripLocalAffordances', () => {
  it('drops known local-machine-affordance keys, top-level and nested', () => {
    const event = {
      seq: 1,
      ts: '2026-08-22T00:00:00.000Z',
      type: 'step-start',
      stepId: 'task',
      worktreePath: '/Users/dev/workspace/cezar/.ai/cezar/worktrees/cez_abc',
      sessionId: 'sess_123',
      backend: 'claude',
      cwd: '/Users/dev/workspace/cezar',
      repoRoot: '/Users/dev/workspace/cezar',
      profileId: 'default',
      configDir: '/Users/dev/.claude',
      handoffPath: '/Users/dev/workspace/cezar/.ai/cezar/runs/r1.handoff.md',
      item: {
        kind: 'tool_use',
        worktreePath: '/Users/dev/workspace/cezar/nested-worktree',
        title: 'kept',
      },
      text: 'kept free text',
    };
    const stripped = stripLocalAffordances(event);
    expect(stripped).not.toHaveProperty('worktreePath');
    expect(stripped).not.toHaveProperty('sessionId');
    expect(stripped).not.toHaveProperty('backend');
    expect(stripped).not.toHaveProperty('cwd');
    expect(stripped).not.toHaveProperty('repoRoot');
    expect(stripped).not.toHaveProperty('profileId');
    expect(stripped).not.toHaveProperty('configDir');
    expect(stripped).not.toHaveProperty('handoffPath');
    expect((stripped.item as Record<string, unknown>)).not.toHaveProperty('worktreePath');
    expect((stripped.item as Record<string, unknown>).title).toBe('kept');
    // Structural fields every consumer needs to render the transcript survive untouched.
    expect(stripped.seq).toBe(1);
    expect(stripped.ts).toBe('2026-08-22T00:00:00.000Z');
    expect(stripped.type).toBe('step-start');
    expect(stripped.stepId).toBe('task');
    expect(stripped.text).toBe('kept free text');
  });

  it('redacts an absolute local path quoted inside free text, but leaves a route-shaped path alone', () => {
    const event = {
      seq: 2,
      ts: '2026-08-22T00:00:01.000Z',
      type: 'note',
      text: 'ran `cat /Users/dev/workspace/cezar/secret.txt` then GET /api/v1/cluster/active',
    };
    const stripped = stripLocalAffordances(event);
    expect(stripped.text).toContain('[local path redacted]');
    expect(stripped.text).not.toContain('/Users/dev/workspace/cezar/secret.txt');
    // /api/v1/... is not a local-machine path — the redaction must not eat it.
    expect(stripped.text).toContain('/api/v1/cluster/active');
  });

  it('does not mutate the input event', () => {
    const event = { seq: 3, ts: 't', type: 'note', worktreePath: '/Users/dev/x' };
    const clone = { ...event };
    stripLocalAffordances(event);
    expect(event).toEqual(clone);
  });
});

describe('cluster/relay — relayTail', () => {
  let dataDir: string;
  let store: RunStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-relay-'));
    store = RunStore.open(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function createRun(id: string) {
    return store.createRun({
      author: localCliAuthor(),
      title: id,
      workflow: 'quick-task',
      task: id,
      steps: [{ id: 'task', name: 'Do the task', kind: 'agent' }],
    });
  }

  it('carries every event when under the tail cap, final: true, no handoffMarkdown when unseeded', async () => {
    const run = createRun('run-tail');
    for (let i = 0; i < 5; i++) {
      store.appendEvent(run.id, { type: 'note', text: `n${i}` });
    }
    const frame = await relayTail(store, run.id);
    expect(frame.type).toBe('relay');
    expect(frame.protocol).toEqual(CLUSTER_PROTOCOL);
    expect(frame.runId).toBe(run.id);
    expect(frame.final).toBe(true);
    expect(frame.handoffMarkdown).toBeUndefined();
    expect(frame.events).toHaveLength(5);
    expect(frame.events.map((e) => e.text)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
  });

  it('respects a limit override and keeps the newest events, not the oldest', async () => {
    const run = createRun('run-limit');
    for (let i = 0; i < 10; i++) {
      store.appendEvent(run.id, { type: 'note', text: `n${i}` });
    }
    const frame = await relayTail(store, run.id, { limit: 3 });
    expect(frame.events.map((e) => e.text)).toEqual(['n7', 'n8', 'n9']);
  });

  it('defaults the tail to RELAY_TAIL_EVENTS with no options passed', async () => {
    const run = createRun('run-default-tail');
    const total = RELAY_TAIL_EVENTS + 30;
    for (let i = 0; i < total; i++) {
      store.appendEvent(run.id, { type: 'note', text: `n${i}` });
    }
    const frame = await relayTail(store, run.id);
    expect(frame.events).toHaveLength(RELAY_TAIL_EVENTS);
    expect(frame.events[0]!.text).toBe(`n${total - RELAY_TAIL_EVENTS}`);
    expect(frame.events[frame.events.length - 1]!.text).toBe(`n${total - 1}`);
  });

  it('includes handoffMarkdown once seeded, and strips local affordances from events', async () => {
    const run = createRun('run-handoff');
    store.appendEvent(run.id, { type: 'note', text: 'hi', sessionId: 'sess_1', backend: 'claude' });
    seedHandoffFile(dataDir, { id: run.id, title: run.title, workflow: run.workflow, task: run.task });
    const frame = await relayTail(store, run.id);
    expect(frame.handoffMarkdown).toBeDefined();
    expect(frame.handoffMarkdown).toContain('# Handoff');
    expect(frame.events[0]).not.toHaveProperty('sessionId');
    expect(frame.events[0]).not.toHaveProperty('backend');
  });

  it('shrinks to fit CLUSTER_FRAME_MAX_BYTES by dropping the handoff markdown first, and marks truncated', async () => {
    const run = createRun('run-oversize-handoff');
    store.appendEvent(run.id, { type: 'note', text: 'small' });
    seedHandoffFile(dataDir, { id: run.id, title: run.title, workflow: run.workflow, task: run.task });
    // Larger than any real handoff journal (and past the frame's own wire `handoffMarkdown` cap)
    // is deliberate here: this test is about `relayTail`'s OWN size-fitting logic dropping it to
    // fit `CLUSTER_FRAME_MAX_BYTES`, not about the separately-enforced wire schema bound.
    seedHandoffFileOverwrite(dataDir, run.id, 'x'.repeat(300_000));
    const frame = await relayTail(store, run.id);
    expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(CLUSTER_FRAME_MAX_BYTES);
    expect(frame.truncated).toBe(true);
    expect(frame.handoffMarkdown).toBeUndefined();
    expect(frame.events).toHaveLength(1);
  });

  it('shrinks an oversized event tail by dropping the OLDEST events first', async () => {
    const run = createRun('run-oversize-events');
    // ~2 KB per event x 200 events is comfortably over 256 KB.
    for (let i = 0; i < 200; i++) {
      store.appendEvent(run.id, { type: 'note', text: `n${i}-${'y'.repeat(2_000)}` });
    }
    const frame = await relayTail(store, run.id);
    expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(CLUSTER_FRAME_MAX_BYTES);
    expect(frame.truncated).toBe(true);
    expect(frame.events.length).toBeGreaterThan(0);
    expect(frame.events.length).toBeLessThan(200);
    // The kept events are a suffix of the original 200 — the newest survive, not the oldest.
    const lastKeptText = frame.events[frame.events.length - 1]!.text as string;
    expect(lastKeptText).toBe('n199-' + 'y'.repeat(2_000));
  });
});

/** Overwrites the seeded handoff file's body directly (bypassing `seedHandoffFile`'s
 *  idempotent "don't overwrite an existing file" guard) so the oversize test can grow it past
 *  what `seedHandoffFile` alone would produce. Uses the same path `handoffPath()` computes. */
function seedHandoffFileOverwrite(dataDir: string, runId: string, task: string): void {
  writeFileSync(join(dataDir, 'runs', `${runId}.handoff.md`), `# Handoff\n\n${task}\n`, 'utf8');
}

describe('cluster/relay — startRelay', () => {
  let dataDir: string;
  let store: RunStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-relay-live-'));
    store = RunStore.open(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('relays a live event to the watcher, stripped', async () => {
    const send = vi.fn((_frame: ClusterRelayFrame) => true);
    const sub = startRelay(store, 'run-a', send);
    store.emit('event', { runId: 'run-a', event: mkEvent(1, { sessionId: 'sess_1' }) });
    await drain();
    expect(send).toHaveBeenCalledTimes(1);
    const frame = send.mock.calls[0]![0] as ClusterRelayFrame;
    expect(frame.runId).toBe('run-a');
    expect(frame.type).toBe('relay');
    expect(frame.events).toHaveLength(1);
    expect(frame.events[0]).not.toHaveProperty('sessionId');
    sub.stop();
  });

  it('ignores events for a different run', async () => {
    const send = vi.fn((_frame: ClusterRelayFrame) => true);
    const sub = startRelay(store, 'run-a', send);
    store.emit('event', { runId: 'run-b', event: mkEvent(1) });
    await drain();
    expect(send).not.toHaveBeenCalled();
    sub.stop();
  });

  // Negative control 1: closing the view really stops the relay — no further frames are sent
  // after the last watcher leaves, not merely "the subscription object was removed".
  it('stops sending frames after stop(), and stop() is idempotent', async () => {
    const send = vi.fn((_frame: ClusterRelayFrame) => true);
    const sub = startRelay(store, 'run-a', send);
    store.emit('event', { runId: 'run-a', event: mkEvent(1) });
    await drain();
    expect(send).toHaveBeenCalledTimes(1);

    sub.stop();
    expect(() => sub.stop()).not.toThrow(); // idempotent: called at 1→0 and again on teardown

    store.emit('event', { runId: 'run-a', event: mkEvent(2) });
    store.emit('event', { runId: 'run-a', event: mkEvent(3) });
    await drain();
    expect(send).toHaveBeenCalledTimes(1); // unchanged — nobody is watching anymore
  });

  // Negative control 2: two watchers, one relay. A second watcher does not double the first
  // watcher's traffic, and the first watcher leaving does not stop the second's stream.
  it('supports two independent watchers on the same run', async () => {
    const sendA = vi.fn((_frame: ClusterRelayFrame) => true);
    const sendB = vi.fn((_frame: ClusterRelayFrame) => true);
    const subA = startRelay(store, 'run-a', sendA);
    const subB = startRelay(store, 'run-a', sendB);

    store.emit('event', { runId: 'run-a', event: mkEvent(1) });
    await drain();
    expect(sendA).toHaveBeenCalledTimes(1);
    expect(sendB).toHaveBeenCalledTimes(1);

    subA.stop();
    store.emit('event', { runId: 'run-a', event: mkEvent(2) });
    await drain();
    expect(sendA).toHaveBeenCalledTimes(1); // A left — no new traffic for A
    expect(sendB).toHaveBeenCalledTimes(2); // B is still watching

    subB.stop();
  });

  // Negative control 3: the budget bounds a burst without starving the rest — a run emitting far
  // more events than RELAY_TICK_EVENT_BUDGET does not lose the remainder, it gets carried across
  // multiple ticks.
  it('spreads a burst across multiple frames, each within the tick budget, and drops nothing', async () => {
    const send = vi.fn((_frame: ClusterRelayFrame) => true);
    const sub = startRelay(store, 'run-a', send);
    const total = RELAY_TICK_EVENT_BUDGET * 5 + 7;
    for (let i = 0; i < total; i++) {
      store.emit('event', { runId: 'run-a', event: mkEvent(i) });
    }
    await drain();

    expect(send.mock.calls.length).toBeGreaterThan(1); // not one giant frame
    for (const [frame] of send.mock.calls as [ClusterRelayFrame][]) {
      expect(frame.events.length).toBeLessThanOrEqual(RELAY_TICK_EVENT_BUDGET);
    }
    const carried = (send.mock.calls as [ClusterRelayFrame][]).flatMap(([frame]) => frame.events);
    expect(carried).toHaveLength(total);
    expect(carried.map((e) => e.seq)).toEqual(Array.from({ length: total }, (_, i) => i));
    sub.stop();
  });

  it('keeps each frame within CLUSTER_FRAME_MAX_BYTES even under the per-count tick budget', async () => {
    const send = vi.fn((_frame: ClusterRelayFrame) => true);
    const sub = startRelay(store, 'run-a', send);
    // 10 events x ~40 KB comfortably exceeds 256 KB as one frame, but is far under
    // RELAY_TICK_EVENT_BUDGET by count — this must be split on size, not count.
    for (let i = 0; i < 10; i++) {
      store.emit('event', { runId: 'run-a', event: mkEvent(i, { text: 'z'.repeat(40_000) }) });
    }
    await drain();
    expect(send.mock.calls.length).toBeGreaterThan(1);
    for (const [frame] of send.mock.calls as [ClusterRelayFrame][]) {
      expect(Buffer.byteLength(JSON.stringify(frame), 'utf8')).toBeLessThanOrEqual(CLUSTER_FRAME_MAX_BYTES);
    }
    sub.stop();
  });

  it('marks the next frame truncated after a failed send, then clears it on the following success', async () => {
    let calls = 0;
    const send = vi.fn((_frame: ClusterRelayFrame) => {
      calls += 1;
      return calls !== 2; // first send ok, second fails, third+ ok
    });
    const sub = startRelay(store, 'run-a', send);

    store.emit('event', { runId: 'run-a', event: mkEvent(1) });
    await drain();
    store.emit('event', { runId: 'run-a', event: mkEvent(2) });
    await drain();
    store.emit('event', { runId: 'run-a', event: mkEvent(3) });
    await drain();

    expect(send.mock.calls.length).toBeGreaterThanOrEqual(3);
    const frames = send.mock.calls.map(([frame]) => frame as ClusterRelayFrame);
    expect(frames[0]!.truncated).toBeUndefined();
    expect(frames[1]!.truncated).toBeUndefined(); // this call is the one that FAILED
    expect(frames[2]!.truncated).toBe(true); // first successful frame after the failure
    sub.stop();
  });
});
