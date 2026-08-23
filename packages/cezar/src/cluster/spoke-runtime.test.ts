import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  type ClusterDispatchFrame,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterPresenceFrame,
  type ClusterRelayRequestFrame,
  type ClusterReplicaFrame,
  type ClusterRepoFreshness,
  type ClusterUplinkFrame,
} from '@loki-labs/better-cezar-contract';
import { startSpokeRuntime, type SpokeLink } from './spoke-runtime.ts';

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
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, warn: () => {} });

    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.type).toBe('presence');
    dispose();
  });

  it('beats every heartbeatMs', async () => {
    const { link, sent } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, warn: () => {} });

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
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, warn: () => {} });

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
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, warn: () => {} });
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
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, warn: () => {} });

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
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, warn });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(warn).toHaveBeenCalledTimes(1); // 4 misses, one warning

    setOnline(true);
    await vi.advanceTimersByTimeAsync(1_000); // recovers
    setOnline(false);
    await vi.advanceTimersByTimeAsync(1_000); // a NEW outage

    expect(warn).toHaveBeenCalledTimes(2); // one more warning for the second outage
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
    const dispose = startSpokeRuntime({ link, heartbeatMs: 1_000, collectPresence, warn });

    await vi.advanceTimersByTimeAsync(0); // fails
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('git exploded'));

    await vi.advanceTimersByTimeAsync(1_000); // recovers on the next tick
    expect(sent).toHaveLength(1);
    dispose();
  });

  it('unref()s the interval timer so a bare process can exit', () => {
    vi.useRealTimers();
    const { link } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

    const dispose = startSpokeRuntime({ link, heartbeatMs: 3_600_000, collectPresence, warn: () => {} });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const timer = setIntervalSpy.mock.results[0]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false); // real Node semantics, not vacuous — a non-unref'd timer is true here

    dispose();
    setIntervalSpy.mockRestore();
  });
});

describe('startSpokeRuntime — downlink dispatch', () => {
  it('declines a dispatch with a truthful freshness frame, naming dispatch-not-accepted', async () => {
    const { link, sent, emit } = createFakeLink();
    const drift = makeDrift();
    const collectPresence = vi.fn(async () => makePresence({ repoDrift: [drift] }));
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, warn: () => {} });
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
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, warn });
    await vi.advanceTimersByTimeAsync(0);
    sent.length = 0;

    emit(makeDispatch({ dispatchId: 'd7', projectKey: 'proj_unknown' }));
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proj_unknown'));
    dispose();
  });
});

describe('startSpokeRuntime — downlink replica / relay / handshake frames', () => {
  it('warns and ignores a replica frame — replication is not applied in this build', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, warn });
    await vi.advanceTimersByTimeAsync(0);

    const replica: ClusterReplicaFrame = {
      type: 'replica',
      protocol: CLUSTER_PROTOCOL,
      scope: 'workspace',
      changes: [],
      hubSeq: 1,
    };
    emit(replica);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not wired'));
    dispose();
  });

  it('warns on a relay request — relaying is not built yet', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, warn });
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

  it('does not warn on ack/welcome/refuse — expected traffic owned elsewhere', async () => {
    const { link, emit } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const warn = vi.fn();
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, warn });
    await vi.advanceTimersByTimeAsync(0);
    warn.mockClear();

    emit({ type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'workspace', throughHubSeq: 1 });
    emit({ type: 'welcome', protocol: CLUSTER_PROTOCOL, hubNodeId: 'hub', roster: [], pairings: [], resumeFrom: [] });
    emit({ type: 'refuse', protocol: CLUSTER_PROTOCOL, reason: 'unknown-node' });

    expect(warn).not.toHaveBeenCalled();
    dispose();
  });

  it('detaches the frame listener on dispose', async () => {
    const { link, listeners } = createFakeLink();
    const collectPresence = vi.fn(async () => makePresence());
    const dispose = startSpokeRuntime({ link, heartbeatMs: 60_000, collectPresence, warn: () => {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(listeners).toHaveLength(1);

    dispose();
    expect(listeners).toHaveLength(0);
  });
});
