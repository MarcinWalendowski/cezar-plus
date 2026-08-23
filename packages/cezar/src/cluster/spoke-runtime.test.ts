import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_PROTOCOL,
  type ClusterAckFrame,
  type ClusterAckResult,
  type ClusterDispatchFrame,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterOpsFrame,
  type ClusterPresenceFrame,
  type ClusterRelayRequestFrame,
  type ClusterReplicaFrame,
  type ClusterRepoFreshness,
  type ClusterUplinkFrame,
  clusterWatermarkSchema,
} from '@loki-labs/better-cezar-contract';
import type { ApplyHubReplicaInput, TodoItem } from '../todos.ts';
import { applyHubReplica as applyHubReplicaFile, readTodos as readTodosFile } from '../todos.ts';
import type { ReplicaApplyResult } from './replica.ts';
import { startSpokeRuntime, type OutboxDiscovery, type SpokeLink, type SpokeOutboxProject } from './spoke-runtime.ts';

/** A plain fake `SpokeLink` — no socket, no `ClusterLinkClient` — so the runtime is driven
 *  directly. `send` is switchable online/offline mid-test; `emit` drives the frame listener the
 *  runtime registered via `on('frame', …)`, the same way `ClusterLinkClient` would. */
function createFakeLink() {
  const listeners: Array<(frame: ClusterDownlinkFrame) => void> = [];
  const sent: ClusterUplinkFrame[] = [];
  let online = true;

  const send = vi.fn((frame: ClusterUplinkFrame): boolean => {
    if (!online) return false;
    sent.push(frame);
    return true;
  });
  const on = vi.fn((_event: 'frame', listener: (frame: ClusterDownlinkFrame) => void) => {
    listeners.push(listener);
  });
  const off = vi.fn((_event: 'frame', listener: (frame: ClusterDownlinkFrame) => void) => {
    const idx = listeners.indexOf(listener);
    if (idx !== -1) listeners.splice(idx, 1);
  });

  const link: SpokeLink & { send: typeof send; on: typeof on; off: typeof off } = { send, on, off };

  return {
    link,
    sent,
    listeners,
    setOnline: (v: boolean) => {
      online = v;
    },
    emit: (frame: ClusterDownlinkFrame) => {
      for (const l of [...listeners]) l(frame);
    },
  };
}

function makePresence(overrides: { active?: number; repoDrift?: ClusterRepoFreshness[] } = {}): ClusterPresenceFrame {
  return {
    type: 'presence',
    protocol: CLUSTER_PROTOCOL,
    capacity: { maxParallel: 4, active: overrides.active ?? 0, heavyActive: 0, enforcement: 'none' },
    repoDrift: overrides.repoDrift ?? [],
  };
}

function makeDrift(overrides: Partial<ClusterRepoFreshness> = {}): ClusterRepoFreshness {
  return {
    projectKey: 'proj_a',
    headSha: 'a'.repeat(40),
    ahead: 1,
    behind: 2,
    dirty: 3,
    merging: false,
    ...overrides,
  };
}

function makeDispatch(overrides: Partial<ClusterDispatchFrame> = {}): ClusterDispatchFrame {
  return {
    type: 'dispatch',
    protocol: CLUSTER_PROTOCOL,
    dispatchId: 'd1',
    todoId: 't1',
    projectKey: 'proj_a',
    placement: {},
    workflow: { builtinId: 'implement' },
    ...overrides,
  };
}

/** No identity, no confirmed projects — every OLD (pre-Milestone-B) test in this file exercises the
 *  presence heartbeat and/or dispatch handling only, and must stay fully isolated from the outbox
 *  flush loop's real, disk-reading default (`discoverOutboxProjects`). Without this override those
 *  tests would silently start reading THIS machine's real `~/.cezar` on every `opFlushMs` tick —
 *  harmless (read-only, degrades to "no identity" when absent) but nondeterministic and a real trap
 *  on a machine that happens to have joined a cluster for other reasons this session. */
const NOOP_OUTBOX = async (): Promise<OutboxDiscovery> => ({ nodeId: undefined, projects: [] });

function makeProject(overrides: Partial<SpokeOutboxProject> = {}): SpokeOutboxProject {
  return { projectKey: 'proj_a', dataDir: '/fake/proj_a/.ai/cezar', ...overrides };
}

function makeDiscovery(overrides: Partial<OutboxDiscovery> = {}): OutboxDiscovery {
  return { nodeId: 'node_a', projects: [makeProject()], ...overrides };
}

function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
  return { id: 't1', summary: 'do the thing', ...overrides } as TodoItem;
}

function opsFramesOf(sent: readonly ClusterUplinkFrame[]): ClusterOpsFrame[] {
  return sent.filter((f): f is ClusterOpsFrame => f.type === 'ops');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startSpokeRuntime — presence heartbeat', () => {
  it('sends a presence frame immediately on start, without waiting a full interval', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('presence');
    dispose();
  });

  it('beats every heartbeatMs', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 1_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0); // the immediate beat
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sent).toHaveLength(4); // 1 immediate + 3 ticks
    dispose();
  });

  it('negative control: dispose() actually stops the heartbeat, not just "does not throw"', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 1_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    const countAtDispose = sent.length;
    expect(countAtDispose).toBeGreaterThan(0);

    dispose();
    await vi.advanceTimersByTimeAsync(60_000); // a long way past several more intervals

    expect(sent).toHaveLength(countAtDispose); // no growth after dispose
  });

  it('dispose() is idempotent', async () => {
    const { link } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 1_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(() => {
      dispose();
      dispose();
    }).not.toThrow();
  });

  it('negative control: an offline outage never queues a backlog — reconnect delivers exactly one, current, beat', async () => {
    const { link, sent, setOnline } = createFakeLink();
    let counter = 0;
    const collectPresence = vi.fn(async () => makePresence({ active: counter++ }));
    setOnline(false);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 1_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0); // attempt 0, offline
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1, offline
    await vi.advanceTimersByTimeAsync(1_000); // attempt 2, offline

    expect(link.send).toHaveBeenCalledTimes(3);
    expect(sent).toHaveLength(0); // nothing delivered while offline

    setOnline(true);
    await vi.advanceTimersByTimeAsync(1_000); // attempt 3, online

    expect(link.send).toHaveBeenCalledTimes(4);
    expect(sent).toHaveLength(1); // exactly one delivered — not a burst of the 3 missed beats
    const capacity = (sent[0] as ClusterPresenceFrame).capacity;
    expect(capacity.active).toBe(3); // the CURRENT reading (4th collectPresence call), not stale data
    dispose();
  });

  it('warns at most once per outage, not once per missed beat', async () => {
    const { link, setOnline } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const warn = vi.fn();
    setOnline(false);
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, collectOutboxProjects: NOOP_OUTBOX, warn });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    const heartbeatWarnings = warn.mock.calls.filter(([m]) => (m as string).includes('presence heartbeat'));
    expect(heartbeatWarnings).toHaveLength(1); // 4 misses, one warning

    setOnline(true);
    await vi.advanceTimersByTimeAsync(1_000); // recovers
    setOnline(false);
    await vi.advanceTimersByTimeAsync(1_000); // a NEW outage

    const heartbeatWarnings2 = warn.mock.calls.filter(([m]) => (m as string).includes('presence heartbeat'));
    expect(heartbeatWarnings2).toHaveLength(2); // one more warning for the second outage
    dispose();
  });

  it('a collectPresence() rejection is warned and skipped, not thrown as an unhandled rejection', async () => {
    const { link, sent } = createFakeLink();
    let calls = 0;
    const collectPresence = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('git exploded');
      return makePresence();
    });
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, collectOutboxProjects: NOOP_OUTBOX, warn });

    await vi.advanceTimersByTimeAsync(0); // fails
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('git exploded'));

    await vi.advanceTimersByTimeAsync(1_000); // recovers on the next tick
    expect(sent).toHaveLength(1);
    dispose();
  });

  it('unref()s both interval timers so a bare process can exit', () => {
    vi.useRealTimers();
    const { link } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 3_600_000,
      opFlushMs: 3_600_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(2); // heartbeat + outbox flush
    for (const call of setIntervalSpy.mock.results) {
      const timer = call.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false); // real Node semantics, not vacuous — a non-unref'd timer is true here
    }

    dispose();
    setIntervalSpy.mockRestore();
  });
});

describe('startSpokeRuntime — downlink dispatch', () => {
  it('declines a dispatch with a truthful freshness frame, naming dispatch-not-accepted', async () => {
    const { link, sent, emit } = createFakeLink();
    const drift = makeDrift();
    const collectPresence = vi.fn(async () => makePresence({ repoDrift: [drift] }));
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0; // drop the heartbeat's own presence frame

    emit(makeDispatch({ dispatchId: 'd42', projectKey: drift.projectKey }));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    const frame = sent[0] as ClusterFreshnessFrame;
    expect(frame.type).toBe('freshness');
    expect(frame.refused).toEqual({ dispatchId: 'd42', reason: 'dispatch-not-accepted' });
    expect(frame.projectKey).toBe(drift.projectKey);
    expect(frame.headSha).toBe(drift.headSha);
    expect(frame.ahead).toBe(drift.ahead);
    expect(frame.behind).toBe(drift.behind);
    expect(frame.dirty).toBe(drift.dirty);
    expect(frame.merging).toBe(drift.merging);
    dispose();
  });

  it('refuses to fabricate: no repoDrift entry for the dispatched project means no frame is sent, only a warning', async () => {
    const { link, sent, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence({ repoDrift: [] })); // no drift for any project
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, collectOutboxProjects: NOOP_OUTBOX, warn });
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;

    emit(makeDispatch({ dispatchId: 'd7', projectKey: 'proj_unknown' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proj_unknown'));
    dispose();
  });
});

describe('startSpokeRuntime — downlink relay / handshake frames', () => {
  it('warns on a relay request — relaying is not built yet', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, collectOutboxProjects: NOOP_OUTBOX, warn });
    await vi.advanceTimersByTimeAsync(0);

    const relay: ClusterRelayRequestFrame = {
      type: 'relay',
      protocol: CLUSTER_PROTOCOL,
      runId: 'run_123',
      subscribe: true,
    };
    emit(relay);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run_123'));
    dispose();
  });

  it('does not warn on welcome/refuse — expected traffic owned elsewhere', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, collectOutboxProjects: NOOP_OUTBOX, warn });
    await vi.advanceTimersByTimeAsync(0);
    warn.mockClear();

    emit({ type: 'welcome', protocol: CLUSTER_PROTOCOL, hubNodeId: 'hub', roster: [], pairings: [], resumeFrom: [] });
    emit({ type: 'refuse', protocol: CLUSTER_PROTOCOL, reason: 'unknown-node' });

    expect(warn).not.toHaveBeenCalled();
    dispose();
  });

  it('a workspace-scope ack is a silent no-op — no outbox here to retire from', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, collectOutboxProjects: NOOP_OUTBOX, warn });
    await vi.advanceTimersByTimeAsync(0);
    warn.mockClear();

    emit({ type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'workspace', throughHubSeq: 1 });

    expect(warn).not.toHaveBeenCalled();
    dispose();
  });

  it('detaches the frame listener on dispose', async () => {
    const { link, listeners } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(listeners).toHaveLength(1);

    dispose();
    expect(listeners).toHaveLength(0);
  });
});

describe('startSpokeRuntime — outbox flush', () => {
  it('flushes derived ops for a pending todo', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z', pendingFields: ['summary'] })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0); // the immediate flush

    const frames = opsFramesOf(sent);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.scope).toBe('project');
    expect(frames[0]!.projectKey).toBe('proj_a');
    expect(frames[0]!.ops).toHaveLength(1);
    expect(frames[0]!.ops[0]!.entityId).toBe('t1');
    expect(frames[0]!.ops[0]!.fields).toEqual({ summary: 'do the thing' });
    dispose();
  });

  it('sends NOTHING when nothing is pending — never an empty frame', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo()]); // no pendingSince
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(opsFramesOf(sent)).toHaveLength(0);
    dispose();
  });

  it('no identity yet (not joined a cluster) — the flush loop runs and finds nothing, never throws', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z' })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects: NOOP_OUTBOX, // nodeId: undefined, projects: []
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(opsFramesOf(sent)).toHaveLength(0);
    expect(readTodos).not.toHaveBeenCalled(); // nothing to read for — never guesses a nodeId
    dispose();
  });

  it('negative control: an offline outage never queues a backlog — reconnect delivers exactly one, freshly re-derived frame', async () => {
    const { link, sent, setOnline } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z' })]);
    const warn = vi.fn();
    setOnline(false);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn,
    });

    await vi.advanceTimersByTimeAsync(0); // attempt 0, offline
    await vi.advanceTimersByTimeAsync(1_000); // attempt 1, offline
    await vi.advanceTimersByTimeAsync(1_000); // attempt 2, offline

    expect(opsFramesOf(sent)).toHaveLength(0);
    // Re-derived from disk every tick, never queued in memory: three attempts, three fresh reads.
    expect(readTodos).toHaveBeenCalledTimes(3);

    setOnline(true);
    await vi.advanceTimersByTimeAsync(1_000); // attempt 3, online

    const delivered = opsFramesOf(sent);
    expect(delivered).toHaveLength(1); // exactly one frame, not a burst of the 3 missed attempts
    expect(delivered[0]!.ops).toHaveLength(1); // still just the one pending record — no accumulation

    const outboxWarnings = warn.mock.calls.filter(([m]) => (m as string).includes('outbox flush'));
    expect(outboxWarnings).toHaveLength(1); // one warning for the whole outage, not one per missed tick
    dispose();
  });

  it('reentrancy: a slow readTodos overlapping the next tick does not double-flush', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    let resolveRead: (todos: TodoItem[]) => void;
    const readTodos = vi.fn(
      () =>
        new Promise<TodoItem[]>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0); // the immediate flush starts and blocks on readTodos
    expect(readTodos).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000); // a full tick elapses while the first flush is still in flight
    await vi.advanceTimersByTimeAsync(1_000); // a second tick too
    expect(readTodos).toHaveBeenCalledTimes(1); // the guard skipped both — no overlapping flush

    resolveRead!([makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z' })]);
    await vi.advanceTimersByTimeAsync(0); // let the first flush's promise chain settle
    expect(opsFramesOf(sent)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000); // now the guard is free again
    expect(readTodos).toHaveBeenCalledTimes(2);
    dispose();
  });

  it('disposer stops the flush timer — no further sends after disposal', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z' })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    const countAtDispose = opsFramesOf(sent).length;
    expect(countAtDispose).toBeGreaterThan(0);

    dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(opsFramesOf(sent)).toHaveLength(countAtDispose); // no growth after dispose
  });
});

describe('startSpokeRuntime — ack downlink', () => {
  it('advances the project watermark; an already-applied record (hubSeq <= throughHubSeq) is not resent on the next flush', async () => {
    const { link, sent, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z', hubSeq: 5 })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0); // first flush — not yet acked, resent
    expect(opsFramesOf(sent)).toHaveLength(1);

    const ack: ClusterAckFrame = { type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_a', throughHubSeq: 5 };
    emit(ack);

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000); // second flush — the ack retired it
    expect(opsFramesOf(sent)).toHaveLength(0);
    dispose();
  });

  it('negative control: without the ack, the same record is resent on every flush', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z', hubSeq: 5 })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000); // no ack ever arrived

    expect(opsFramesOf(sent)).toHaveLength(1); // still owed
    dispose();
  });

  it('throughHubSeq only ever advances — an out-of-order/duplicate lower ack cannot un-ack a higher one', async () => {
    const { link, sent, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z', hubSeq: 5 })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    emit({ type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_a', throughHubSeq: 5 });
    emit({ type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_a', throughHubSeq: 2 }); // stale/duplicate

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opsFramesOf(sent)).toHaveLength(0); // still retired — the stale ack did not regress it
    dispose();
  });
});

describe('startSpokeRuntime — replica downlink', () => {
  function makeChange(overrides: Record<string, unknown> = {}) {
    return {
      opId: 'op1',
      nodeId: 'hub_or_other_node',
      ts: '2026-08-23T00:00:00.000Z',
      scope: 'project' as const,
      projectKey: 'proj_a',
      entity: 'todo' as const,
      entityId: 't1',
      op: 'upsert' as const,
      fields: { summary: 'set by the hub' },
      hubSeq: 3,
      ...overrides,
    };
  }

  it('applies a project-scoped replica frame through applyHubReplica', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo()]);
    const applyResult: ReplicaApplyResult = { todos: [makeTodo({ summary: 'set by the hub' })], corrections: [], appliedThroughHubSeq: 3, skipped: 0 };
    const applyHubReplica = vi.fn(async (_dataDir: string, _input: ApplyHubReplicaInput) => applyResult);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      applyHubReplica,
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);

    const frame: ClusterReplicaFrame = { type: 'replica', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_a', changes: [makeChange()], hubSeq: 3 };
    emit(frame);
    await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget apply settle

    expect(applyHubReplica).toHaveBeenCalledTimes(1);
    const [dataDir, input] = applyHubReplica.mock.calls[0]!;
    expect(dataDir).toBe('/fake/proj_a/.ai/cezar');
    expect(input.changes).toEqual([makeChange()]);
    expect(input.appliedThroughHubSeq).toBe(0); // this project's watermark started at 0
    dispose();
  });

  it('an empty-changes (keepalive) push still advances the watermark to frame.hubSeq — the applyReplicaFrame half', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const readTodos = vi.fn(async () => [makeTodo()]);
    const applyHubReplica = vi.fn(async (_dataDir: string, input: ApplyHubReplicaInput) => ({
      todos: [],
      corrections: [],
      appliedThroughHubSeq: input.appliedThroughHubSeq, // real applyReplica: no changes, watermark unmoved
      skipped: 0,
    }));
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence,
      collectOutboxProjects,
      readTodos,
      applyHubReplica,
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);

    const keepalive: ClusterReplicaFrame = { type: 'replica', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_a', changes: [], hubSeq: 7 };
    emit(keepalive);
    await vi.advanceTimersByTimeAsync(0);

    const second: ClusterReplicaFrame = { type: 'replica', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_a', changes: [makeChange({ hubSeq: 9 })], hubSeq: 9 };
    emit(second);
    await vi.advanceTimersByTimeAsync(0);

    expect(applyHubReplica).toHaveBeenCalledTimes(2);
    // The SECOND call's input carries the watermark the FIRST (empty) call advanced to — proof the
    // keepalive was not a no-op even though `applyHubReplica`'s own return didn't move it.
    expect(applyHubReplica.mock.calls[1]![1].appliedThroughHubSeq).toBe(7);
    dispose();
  });

  it('warns and does not apply a workspace-scope replica frame', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery());
    const applyHubReplica = vi.fn();
    const warn = vi.fn();
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence,
      collectOutboxProjects,
      applyHubReplica,
      warn,
    });
    await vi.advanceTimersByTimeAsync(0);

    const frame: ClusterReplicaFrame = { type: 'replica', protocol: CLUSTER_PROTOCOL, scope: 'workspace', changes: [], hubSeq: 1 };
    emit(frame);
    await vi.advanceTimersByTimeAsync(0);

    expect(applyHubReplica).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('project-scoped'));
    dispose();
  });

  it('warns and does not apply a replica frame for a project this node has not confirmed pairing for', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const collectOutboxProjects = vi.fn(async () => makeDiscovery({ projects: [] })); // nothing confirmed
    const applyHubReplica = vi.fn();
    const warn = vi.fn();
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence,
      collectOutboxProjects,
      applyHubReplica,
      warn,
    });
    await vi.advanceTimersByTimeAsync(0);

    const frame: ClusterReplicaFrame = { type: 'replica', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_unpaired', changes: [], hubSeq: 1 };
    emit(frame);
    await vi.advanceTimersByTimeAsync(0);

    expect(applyHubReplica).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proj_unpaired'));
    dispose();
  });

  describe('integration — the real todos.ts store API', () => {
    let dataDir: string;

    beforeEach(async () => {
      const root = await mkdtemp(join(tmpdir(), 'cez-spoke-runtime-'));
      dataDir = join(root, '.ai/cezar');
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'todos.json'), JSON.stringify([{ id: 't1', summary: 'original' }]), 'utf8');
    });

    afterEach(async () => {
      await rm(join(dataDir, '..', '..'), { recursive: true, force: true });
    });

    it('a replica frame is applied through the real store API and lands on disk', async () => {
      vi.useRealTimers(); // real fs I/O under a real O_EXCL lease — see the module's own note on why
      const { link, emit } = createFakeLink();
      const collectPresence = async () => makePresence();
      const collectOutboxProjects = async (): Promise<OutboxDiscovery> => ({
        nodeId: 'node_a',
        projects: [{ projectKey: 'proj_a', dataDir }],
      });

      let settleApply: () => void;
      const applied = new Promise<void>((resolve) => {
        settleApply = resolve;
      });
      const applyHubReplica = async (dir: string, input: ApplyHubReplicaInput) => {
        const result = await applyHubReplicaFile(dir, input);
        settleApply();
        return result;
      };

      const dispose = startSpokeRuntime({
        link,
        heartbeatMs: 3_600_000,
        opFlushMs: 3_600_000, // no interfering flush tick — this test drives one replica frame only
        collectPresence,
        collectOutboxProjects,
        readTodos: readTodosFile, // real, reads the tmp dir
        applyHubReplica,
        warn: () => {},
      });

      const frame: ClusterReplicaFrame = {
        type: 'replica',
        protocol: CLUSTER_PROTOCOL,
        scope: 'project',
        projectKey: 'proj_a',
        changes: [{ opId: 'op1', nodeId: 'other_node', ts: new Date().toISOString(), scope: 'project', projectKey: 'proj_a', entity: 'todo', entityId: 't1', op: 'upsert', fields: { summary: 'updated by hub' }, hubSeq: 1 }],
        hubSeq: 1,
      };
      emit(frame);
      await applied;

      const onDisk = JSON.parse(await readFile(join(dataDir, 'todos.json'), 'utf8')) as Array<{ id: string; summary: string }>;
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0]!.summary).toBe('updated by hub');
      dispose();
    });
  });
});

/**
 * The multi-project sweep, and specifically what `flushOps`'s `link-down` early break does to the
 * projects BEHIND the one that failed. Every other outbox test in this file drives exactly one
 * project, so the break itself — and the ordering it interacts with — was unpinned until here.
 */
describe('startSpokeRuntime — outbox flush across many projects (the link-down early break)', () => {
  const KEYS = ['proj_a', 'proj_b', 'proj_c', 'proj_d', 'proj_e'] as const;

  /** Five confirmed pairings in registry order. `discoverOutboxProjects` builds this list by walking
   *  `peers.pairings` (`peers.ts` appends a new pairing and index-replaces an updated one), so the
   *  order is insertion order and is STABLE across ticks — which is exactly what makes "who is at
   *  the front" a durable property rather than a per-tick coin flip. */
  function fiveProjects(): SpokeOutboxProject[] {
    return KEYS.map((projectKey) => ({ projectKey, dataDir: `/fake/${projectKey}/.ai/cezar` }));
  }

  function projectOf(dataDir: string): string {
    return dataDir.split('/')[2]!;
  }

  function opsKeysOf(sent: readonly ClusterUplinkFrame[]): string[] {
    return opsFramesOf(sent).map((f) => f.projectKey!);
  }

  /** One pending todo per project, so every project owes exactly one op and therefore attempts
   *  exactly one send — making "which projects were attempted" readable straight off the frames. */
  function onePendingTodoPerProject(summaryBytes: Partial<Record<string, number>> = {}) {
    return async (dataDir: string): Promise<TodoItem[]> => {
      const key = projectOf(dataDir);
      return [
        makeTodo({
          id: `t_${key}`,
          summary: 'x'.repeat(summaryBytes[key] ?? 8),
          pendingSince: '2026-08-23T00:00:00.000Z',
          pendingFields: ['summary'],
        }),
      ];
    };
  }

  it('a link drop mid-sweep stops the pass — the projects behind the failure are not even READ this tick', async () => {
    const { link, sent, setOnline } = createFakeLink();
    const readTodos = vi.fn(async (dataDir: string): Promise<TodoItem[]> => {
      // The link drops WHILE project 3 of 5 is being flushed — before its own send, after a & b's.
      if (projectOf(dataDir) === 'proj_c') setOnline(false);
      return onePendingTodoPerProject()(dataDir);
    });
    const warn = vi.fn();
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery({ projects: fiveProjects() }),
      readTodos,
      warn,
    });

    await vi.advanceTimersByTimeAsync(0); // the immediate flush

    // The two ahead of the drop landed; proj_c's send was attempted and refused.
    expect(opsKeysOf(sent)).toEqual(['proj_a', 'proj_b']);
    // The sharp pin on the break: d and e were never even read, let alone sent. Their `todos.json`
    // is not touched at all once the link is known to be down.
    expect(readTodos.mock.calls.map(([d]) => projectOf(d))).toEqual(['proj_a', 'proj_b', 'proj_c']);
    // Post-loop bookkeeping still ran after the early exit: one outage warning for the whole sweep,
    // not one per remaining project and not none.
    expect(warn.mock.calls.filter(([m]) => (m as string).includes('outbox flush'))).toHaveLength(1);
    dispose();
  });

  it('nothing behind the drop is lost — the next tick re-derives from disk and delivers every skipped project', async () => {
    const { link, sent, setOnline } = createFakeLink();
    let dropAtC = true;
    const readTodos = vi.fn(async (dataDir: string): Promise<TodoItem[]> => {
      if (dropAtC && projectOf(dataDir) === 'proj_c') setOnline(false);
      return onePendingTodoPerProject()(dataDir);
    });
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery({ projects: fiveProjects() }),
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0); // tick 1: stops at proj_c
    expect(opsKeysOf(sent)).toEqual(['proj_a', 'proj_b']);

    dropAtC = false;
    setOnline(true);
    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000); // tick 2, link healthy again

    // c is still owed (it was never sent, only attempted), and d & e were never lost — the records
    // themselves are the durable intent (D5), so a re-derivation is all it takes. Asserted as a
    // SET, not a sequence: this tick's sweep resumes past the project that blocked the last one, so
    // the order is d,e,a,b,c here. Which five, and how many, is the property this test is about —
    // the rotated order itself is pinned by its own test below, and the unrotated one above.
    expect([...opsKeysOf(sent)].sort()).toEqual([...KEYS].sort());
    expect(opsKeysOf(sent)[0]).toBe('proj_d'); // resumed just past proj_c, rather than re-doing a,b
    dispose();
  });

  it('control: with the link up throughout, every project flushes on every tick, in registry order', async () => {
    const { link, sent } = createFakeLink();
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery({ projects: fiveProjects() }),
      readTodos: onePendingTodoPerProject(),
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(opsKeysOf(sent)).toEqual([...KEYS]);

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(opsKeysOf(sent)).toEqual([...KEYS]); // unchanged order, nothing rotated away on a clean pass
    dispose();
  });

  /** `send()` returning `false` is THREE conditions, not one (`link-client.ts#send`/`writeFrame`):
   *  offline, over this window's frame budget, or over `CLUSTER_FRAME_MAX_BYTES`. Only the first
   *  matches the early break's stated premise ("the link is down for this node, not just this
   *  project"). This link models the third — the one that is neither transient nor about the link:
   *  it recurs identically on every tick until the RECORD changes. */
  function createFrameBoundLink() {
    const base = createFakeLink();
    const rejecting: SpokeLink['send'] = (frame: ClusterUplinkFrame): boolean => {
      if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > CLUSTER_FRAME_MAX_BYTES) return false;
      return base.link.send(frame);
    };
    return { ...base, link: { ...base.link, send: vi.fn(rejecting) } as unknown as SpokeLink & { send: ReturnType<typeof vi.fn> } };
  }

  it('a project whose frame the link can NEVER accept must not starve the projects behind it', async () => {
    const { link, sent } = createFrameBoundLink();
    // proj_c owes one record too big for any frame — `packOpsFrame` sends an oversized single op
    // rather than stalling on it (`ops.ts`), and the link then refuses the frame, every tick.
    const readTodos = vi.fn(onePendingTodoPerProject({ proj_c: CLUSTER_FRAME_MAX_BYTES + 1_000 }));
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 3_600_000,
      opFlushMs: 1_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery({ projects: fiveProjects() }),
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    for (let tick = 0; tick < 11; tick++) await vi.advanceTimersByTimeAsync(1_000);

    const delivered = opsKeysOf(sent);
    // The unrepresentable project itself genuinely cannot be flushed — that is a separate defect
    // (see this module's docblock) and this test does not pretend to fix it.
    expect(delivered).not.toContain('proj_c');
    // Everything AHEAD of it keeps flowing, as it always did.
    expect(delivered.filter((k) => k === 'proj_a').length).toBeGreaterThan(0);
    // ...and everything BEHIND it must get its turn too. One poisoned record in one project is not
    // allowed to be a permanent outage for every project after it in a stable ordering.
    expect(delivered.filter((k) => k === 'proj_d').length).toBeGreaterThan(0);
    expect(delivered.filter((k) => k === 'proj_e').length).toBeGreaterThan(0);
    dispose();
  });

  it('the rotation is bounded, not a queue: a persistent blocker costs the tail a turn, never its place', async () => {
    const { link, sent } = createFrameBoundLink();
    const readTodos = vi.fn(onePendingTodoPerProject({ proj_a: CLUSTER_FRAME_MAX_BYTES + 1_000 }));
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 3_600_000,
      opFlushMs: 1_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery({ projects: fiveProjects() }),
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0); // tick 1 stops on proj_a, the very first project
    expect(opsKeysOf(sent)).toEqual([]);

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000); // tick 2 starts past it — the other four all flush

    expect(opsKeysOf(sent)).toEqual(['proj_b', 'proj_c', 'proj_d', 'proj_e']);
    dispose();
  });
});

/**
 * D35 — the ack's `results[]` was read by nothing at all, and a refusal has no second copy: the hub
 * fans out ACCEPTED ops only, so a refused op never comes back as a `replica`, and `replica` is the
 * only thing that clears `pendingSince`. See `spoke-runtime.ts#applyAck`'s amended docblock.
 */
describe('startSpokeRuntime — the ack’s refusals (D35 / D9a)', () => {
  function claimRefusal(overrides: Partial<ClusterAckResult> = {}): ClusterAckResult {
    return {
      opId: 'op_claim_1',
      hubSeq: 7,
      accepted: false,
      reason: 'already-started',
      fields: { startedTaskId: 'run-winner', startedOn: 'node_hel1' },
      ...overrides,
    };
  }

  function ackWith(results: ClusterAckResult[], overrides: Partial<ClusterAckFrame> = {}): ClusterAckFrame {
    return {
      type: 'ack',
      protocol: CLUSTER_PROTOCOL,
      scope: 'project',
      projectKey: 'proj_a',
      throughHubSeq: 7,
      results,
      ...overrides,
    };
  }

  /** No outbox, no disk — these tests drive `applyAck` alone through the frame listener. */
  function startWithWarnCapture(): { emit: (frame: ClusterDownlinkFrame) => void; warns: string[]; dispose: () => void } {
    const { link, emit } = createFakeLink();
    const warns: string[] = [];
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: NOOP_OUTBOX,
      warn: (message) => warns.push(message),
    });
    return { emit, warns, dispose };
  }

  it('a refused claim is REPORTED, naming the op, the reason, and the run/node that won it', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    emit(ackWith([claimRefusal()]));

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('REFUSED 1 of 1 op(s)');
    expect(warns[0]).toContain('op op_claim_1');
    expect(warns[0]).toContain('hubSeq 7');
    expect(warns[0]).toContain('already-started');
    expect(warns[0]).toContain('held by run "run-winner"');
    expect(warns[0]).toContain('node "node_hel1"');
    dispose();
  });

  it('says the run this node already started is NOT stopped by the ack — D9a’s asynchronous path reads backwards without it', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    emit(ackWith([claimRefusal()]));

    // Length first, so a regression that reports NOTHING fails with "expected [] to have a length
    // of 1" rather than chai's "undefined ... is invalid for this assertion", which names neither
    // the test nor the breakage.
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('a claim this node LOST');
    expect(warns[0]).toContain('is NOT stopped by this ack');
    dispose();
  });

  it('negative control: an ack whose results are ALL accepted says nothing — and the fixture really did carry results', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    const accepted: ClusterAckResult[] = [
      { opId: 'op_a', hubSeq: 6, accepted: true },
      // An ACCEPTED claim carries `fields` too (`hub-apply.ts` stamps the winner's own values), so
      // this is the case that catches a report keyed on `fields` instead of on `accepted`.
      { opId: 'op_b', hubSeq: 7, accepted: true, fields: { startedTaskId: 'run-mine', startedOn: 'node_me' } },
    ];
    const frame = ackWith(accepted);
    // The floor: without this the test would pass just as happily against an empty `results`, which
    // is the vacuous version of this control.
    expect(frame.results).toHaveLength(2);
    emit(frame);

    expect(warns).toHaveLength(0);
    dispose();
  });

  it('negative control: an ack with no `results` field at all is silent', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    emit({ type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey: 'proj_a', throughHubSeq: 7 });

    expect(warns).toHaveLength(0);
    dispose();
  });

  it('ONE line per frame, never one per result — a 500-result frame may not write 500 lines', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    const many = Array.from({ length: 9 }, (_, i) => claimRefusal({ opId: `op_${i}`, hubSeq: 10 + i }));
    emit(ackWith(many, { throughHubSeq: 18 }));

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('REFUSED 9 of 9 op(s)');
    expect(warns[0]).toContain('op_0');
    expect(warns[0]).toContain('op_2');
    expect(warns[0]).not.toContain('op_3'); // spelled out to REFUSALS_DETAILED_MAX, then counted
    expect(warns[0]).toContain('+6 more');
    dispose();
  });

  it('a refusal WITHOUT `fields` is reported plainly — forged-author is not a claim loss and must not be described as one', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    emit(
      ackWith([
        { opId: 'op_forged', hubSeq: 4, accepted: false, reason: 'forged-author: op claims "node_x", link authenticated "node_a"' },
      ]),
    );

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('forged-author');
    expect(warns[0]).not.toContain('held by run');
    expect(warns[0]).not.toContain('a claim this node LOST');
    dispose();
  });

  it('a refusal carrying `fields` but no `startedTaskId` is not a claim loss either — the key, not the object, is the signal', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    // No such refusal exists in the tree today (`hub-apply.ts#claimFields` always sets
    // `startedTaskId`), which is exactly why this is worth pinning: a future refusal that returns
    // any other corrected field would otherwise be announced as a lost claim "held by run
    // undefined".
    emit(ackWith([{ opId: 'op_other', hubSeq: 5, accepted: false, reason: 'some-future-reason', fields: { summary: 'corrected' } }]));

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('some-future-reason');
    expect(warns[0]).not.toContain('a claim this node LOST');
    expect(warns[0]).not.toContain('held by run');
    expect(warns[0]).not.toContain('undefined');
    dispose();
  });

  it('a WORKSPACE-scope ack’s refusal is still reported — the scope guard governs the watermark, not the verdict', async () => {
    const { emit, warns, dispose } = startWithWarnCapture();
    await vi.advanceTimersByTimeAsync(0);
    warns.length = 0;

    emit(ackWith([claimRefusal({ opId: 'op_ws' })], { scope: 'workspace', projectKey: undefined }));

    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('op op_ws');
    expect(warns[0]).toContain('workspace ack');
    dispose();
  });

  it('an ACCEPTED result above a gap must not advance the outbox watermark past the gap — the silent loss `hub-ops.ts` names', async () => {
    const { link, sent, emit } = createFakeLink();
    // Op 6 THREW at the hub (a lock timeout, a write error) — so it gets no `results` entry, its
    // hubSeq is burned, and `throughHubSeq` stops at 5. Op 7, in the same frame, succeeded and DOES
    // get a result. `hub-ops.ts`: "a spoke that trusts the watermark alone would then believe the
    // failed op was also durably applied, and drop it."
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z', hubSeq: 6 })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery(),
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(opsFramesOf(sent)).toHaveLength(1); // floor: the record really is owed to begin with

    emit(ackWith([{ opId: 'op_7', hubSeq: 7, accepted: true }], { throughHubSeq: 5 }));

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    // Still owed. Reading `results[].hubSeq` as a watermark would retire op 6 — a write the hub
    // never applied, dropped from the only place it still exists.
    expect(opsFramesOf(sent)).toHaveLength(1);
    dispose();
  });

  // CHARACTERISATION, NOT A GUARD — stated plainly because an unmarked test that cannot fail is
  // worse than no test. No mutation of `spoke-runtime.ts` turns this red: the behaviour it pins is
  // `ops.ts#deriveTodoOps`'s, and the record's `hubSeq` being `undefined` is what disarms that
  // file's watermark guard no matter what this file does with the ack. It is here to make D35's
  // leak concrete and to fail the day someone claims it is fixed without changing `ops.ts`,
  // `replica.ts` or `todos.ts`.
  it('reporting a refusal retires NOTHING — `throughHubSeq` alone still governs the outbox (the D35 leak, characterised)', async () => {
    const { link, sent, emit } = createFakeLink();
    // `pendingSince` set, no `hubSeq` on the record — exactly the state a refused op is left in,
    // since a refusal is never fanned back as a `replica` and nothing else clears `pendingSince`.
    const readTodos = vi.fn(async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z' })]);
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 1_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery(),
      readTodos,
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(opsFramesOf(sent)).toHaveLength(1); // floor: it really was sent once

    // The hub refused it and its `throughHubSeq` covers the refusal (a rejection IS resolved, per
    // `hub-ops.ts`) — but the RECORD carries no `hubSeq`, so `deriveTodoOps`'s watermark guard
    // cannot fire and the record is derived again, with a fresh opId, on the very next tick.
    emit(ackWith([claimRefusal({ opId: 'op_1' })]));

    sent.length = 0;
    await vi.advanceTimersByTimeAsync(1_000);
    const resent = opsFramesOf(sent);
    expect(resent).toHaveLength(1);
    expect(resent[0]!.ops[0]!.opId).not.toBe('op_1'); // a FRESH opId — the hub will durably re-apply
    dispose();
  });
});

/**
 * The hub registers a node in `this.nodes` at socket upgrade (`link-server.ts:196`), BEFORE
 * `hello`/`welcome`, so `connectedNodes()` can hand the fan-out a node mid-handshake. This is what
 * the spoke does when that frame lands first.
 */
describe('startSpokeRuntime — a replica frame that arrives before `welcome`', () => {
  function makeChange(overrides: Record<string, unknown> = {}) {
    return {
      opId: 'op_pre',
      nodeId: 'node_other',
      ts: '2026-08-23T00:00:00.000Z',
      scope: 'project' as const,
      projectKey: 'proj_a',
      entity: 'todo' as const,
      entityId: 't1',
      op: 'upsert' as const,
      fields: { summary: 'set by the hub' },
      hubSeq: 3,
      ...overrides,
    };
  }

  it('is APPLIED, not dropped — there is no handshake gate here, and adding one would silently lose the push', async () => {
    const { link, emit, listeners } = createFakeLink();
    const applyResult: ReplicaApplyResult = { todos: [makeTodo()], corrections: [], appliedThroughHubSeq: 3, skipped: 0 };
    const applyHubReplica = vi.fn(async (_dataDir: string, _input: ApplyHubReplicaInput) => applyResult);
    const seen: ClusterDownlinkFrame[] = [];
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery(),
      readTodos: async () => [makeTodo()],
      applyHubReplica,
      warn: () => {},
    });
    // Floor for "before welcome": record every frame the runtime is given, and assert at the end
    // that no `welcome` was ever among them. Without this the test would pass against a fixture
    // that simply forgot to send one.
    listeners.push((frame) => seen.push(frame));

    const frame: ClusterReplicaFrame = {
      type: 'replica',
      protocol: CLUSTER_PROTOCOL,
      scope: 'project',
      projectKey: 'proj_a',
      changes: [makeChange()],
      hubSeq: 3,
    };
    emit(frame);
    await vi.advanceTimersByTimeAsync(0);

    expect(seen.some((f) => f.type === 'welcome')).toBe(false);
    expect(applyHubReplica).toHaveBeenCalledTimes(1);
    expect(applyHubReplica.mock.calls[0]![1].changes).toEqual([makeChange()]);
    expect(applyHubReplica.mock.calls[0]![1].appliedThroughHubSeq).toBe(0);
    dispose();
  });

  it('a frame whose `hubSeq` outruns what it delivered marks the gap applied — a later push of the skipped op is handed a watermark above it', async () => {
    const { link, emit } = createFakeLink();
    // `applyReplica` itself only advances over changes it saw; `applyReplicaFrame` then takes
    // `max(that, frame.hubSeq)`. So the FRAME's declaration is what wins here.
    const applyHubReplica = vi.fn(async (_dataDir: string, input: ApplyHubReplicaInput) => ({
      todos: [makeTodo()],
      corrections: [],
      appliedThroughHubSeq: input.appliedThroughHubSeq,
      skipped: 0,
    }));
    const dispose = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery(),
      readTodos: async () => [makeTodo()],
      applyHubReplica,
      warn: () => {},
    });

    // Ops 1..11 were never delivered to this node (D30's stale hub watermark, or D29's exclusion).
    emit({
      type: 'replica',
      protocol: CLUSTER_PROTOCOL,
      scope: 'project',
      projectKey: 'proj_a',
      changes: [makeChange({ opId: 'op_12', hubSeq: 12 })],
      hubSeq: 12,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(applyHubReplica.mock.calls[0]![1].appliedThroughHubSeq).toBe(0); // floor: it started at 0

    // Replay now ships op 8, which this node never received.
    emit({
      type: 'replica',
      protocol: CLUSTER_PROTOCOL,
      scope: 'project',
      projectKey: 'proj_a',
      changes: [makeChange({ opId: 'op_8', hubSeq: 8 })],
      hubSeq: 8,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(applyHubReplica).toHaveBeenCalledTimes(2);
    // 12, not 8 — and `replica.ts#applyReplica` skips any change at or below the watermark it is
    // given, so op 8 is discarded rather than applied. Recorded as the current behaviour, not
    // endorsed: the fix belongs where the frame's `hubSeq` is chosen (`replica-fanout.ts`).
    expect(applyHubReplica.mock.calls[1]![1].appliedThroughHubSeq).toBe(12);
    dispose();
  });
});

/**
 * D38 — `link-client.ts#sendHello` hardcodes `hello.watermarks: []`, so the hub asks every node
 * where it is and every node answers "nowhere", and each reconnect replays the whole scope. These
 * pin the spoke's half: report the live position, report nothing this node cannot vouch for, and
 * persist nothing.
 */
describe('startSpokeRuntime — watermarks() for hello (D38)', () => {
  function startWithProject(overrides: Partial<Parameters<typeof startSpokeRuntime>[0]> = {}) {
    const { link, sent, emit } = createFakeLink();
    const handle = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery(),
      readTodos: async () => [makeTodo()],
      warn: () => {},
      ...overrides,
    });
    return { handle, sent, emit };
  }

  const ackFor = (projectKey: string, throughHubSeq: number): ClusterAckFrame => ({
    type: 'ack',
    protocol: CLUSTER_PROTOCOL,
    scope: 'project',
    projectKey,
    throughHubSeq,
  });

  it('reports a position this node actually holds — the ack watermark, read back off the handle', async () => {
    const { handle, emit } = startWithProject();
    await vi.advanceTimersByTimeAsync(0);
    // The floor. If this were not empty the rest of the test would prove nothing about `emit`.
    expect(handle.watermarks()).toEqual([]);

    emit(ackFor('proj_a', 9));

    expect(handle.watermarks()).toEqual([
      { scope: 'project', projectKey: 'proj_a', appliedThroughHubSeq: 0, ackedThroughHubSeq: 9 },
    ]);
    handle();
  });

  it('is a GETTER, not a snapshot — a position taken after the handle was made is still visible', async () => {
    const { handle, emit } = startWithProject();
    await vi.advanceTimersByTimeAsync(0);

    const reader = handle.watermarks; // what `sendHello` would hold across reconnects
    expect(reader()).toEqual([]); // floor: nothing yet

    emit(ackFor('proj_a', 3));
    expect(reader()).toHaveLength(1);
    expect(reader()[0]!.ackedThroughHubSeq).toBe(3);

    emit(ackFor('proj_a', 11)); // a second reconnect must see the NEWER position
    expect(reader()[0]!.ackedThroughHubSeq).toBe(11);
    handle();
  });

  it('carries BOTH positions on one entry — applied from a replica, acked from an ack', async () => {
    const applyHubReplica = vi.fn(async (_dataDir: string, _input: ApplyHubReplicaInput) => ({
      todos: [makeTodo()],
      corrections: [],
      appliedThroughHubSeq: 6,
      skipped: 0,
    }));
    const { handle, emit } = startWithProject({ applyHubReplica });
    await vi.advanceTimersByTimeAsync(0);

    emit({
      type: 'replica',
      protocol: CLUSTER_PROTOCOL,
      scope: 'project',
      projectKey: 'proj_a',
      changes: [],
      hubSeq: 6,
    });
    await vi.advanceTimersByTimeAsync(0);
    emit(ackFor('proj_a', 4));

    expect(handle.watermarks()).toEqual([
      { scope: 'project', projectKey: 'proj_a', appliedThroughHubSeq: 6, ackedThroughHubSeq: 4 },
    ]);
    handle();
  });

  it('a project that has only ever FLUSHED is omitted, not advertised at zero', async () => {
    const { link, sent, emit } = createFakeLink();
    const handle = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => makeDiscovery(),
      readTodos: async () => [makeTodo({ pendingSince: '2026-08-23T00:00:00.000Z' })],
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);

    // THE FLOOR, and the whole point of this test: the flush really ran, and `flushProject` calls
    // `stateFor(projectKey)` before it derives anything — so a `{0,0}` entry for proj_a exists in
    // the map right now. An assertion of `[]` here is about the FILTER, not about an absent entry.
    expect(opsFramesOf(sent)).toHaveLength(1);
    expect(handle.watermarks()).toEqual([]);

    // Proof that the entry was reachable all along: the same key, once it holds a real position,
    // reports immediately — no second project, no re-discovery.
    emit(ackFor('proj_a', 2));
    expect(handle.watermarks()).toEqual([
      { scope: 'project', projectKey: 'proj_a', appliedThroughHubSeq: 0, ackedThroughHubSeq: 2 },
    ]);
    handle();
  });

  it('reports one entry per project, and only the projects that have a position', async () => {
    const { link, emit } = createFakeLink();
    const handle = startSpokeRuntime({
      link,
      heartbeatMs: 60_000,
      opFlushMs: 60_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: async () => ({
        nodeId: 'node_a' as const,
        projects: [makeProject(), makeProject({ projectKey: 'proj_b', dataDir: '/fake/proj_b/.ai/cezar' })],
      }),
      readTodos: async () => [makeTodo()],
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);

    emit(ackFor('proj_a', 5));
    emit(ackFor('proj_b', 8));
    expect(handle.watermarks()).toHaveLength(2); // floor: both really are there

    const byKey = Object.fromEntries(handle.watermarks().map((m) => [m.projectKey, m.ackedThroughHubSeq]));
    expect(byKey).toEqual({ proj_a: 5, proj_b: 8 });
    handle();
  });

  it('every entry validates against the wire schema — `.strict()`, so a stray key would fail here', async () => {
    const { handle, emit } = startWithProject();
    await vi.advanceTimersByTimeAsync(0);
    emit(ackFor('proj_a', 7));

    const marks = handle.watermarks();
    expect(marks).toHaveLength(1); // floor: `z.array(...).parse([])` passes vacuously
    expect(() => z.array(clusterWatermarkSchema).parse(marks)).not.toThrow();
    handle();
  });

  it('keeps answering after dispose — the position it reached is still a true statement', async () => {
    const { handle, emit } = startWithProject();
    await vi.advanceTimersByTimeAsync(0);
    emit(ackFor('proj_a', 12));
    expect(handle.watermarks()).toHaveLength(1); // floor

    handle(); // the disposer, still the same callable it always was

    expect(handle.watermarks()).toEqual([
      { scope: 'project', projectKey: 'proj_a', appliedThroughHubSeq: 0, ackedThroughHubSeq: 12 },
    ]);
  });

  it('the handle is still callable as the plain disposer `cluster-routes.ts` treats it as', async () => {
    const { link, sent } = createFakeLink();
    const handle = startSpokeRuntime({
      link,
      heartbeatMs: 1_000,
      opFlushMs: 60_000,
      collectPresence: async () => makePresence(),
      collectOutboxProjects: NOOP_OUTBOX,
      warn: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstBeat = sent.length;
    expect(afterFirstBeat).toBeGreaterThan(0); // floor: the heartbeat really was running

    handle(); // `stopHeartbeat()` at cluster-routes.ts:1157
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(afterFirstBeat); // stopped
  });
});
