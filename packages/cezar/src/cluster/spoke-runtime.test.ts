import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  type ClusterAckFrame,
  type ClusterDispatchFrame,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterOpsFrame,
  type ClusterPresenceFrame,
  type ClusterRelayRequestFrame,
  type ClusterReplicaFrame,
  type ClusterRepoFreshness,
  type ClusterUplinkFrame,
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
