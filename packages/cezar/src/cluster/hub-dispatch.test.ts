import { describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  clusterDispatchFrameSchema,
  type ClusterActiveRun,
  type ClusterCapacity,
  type ClusterFreshnessFrame,
} from '@loki-labs/cezar-plus-contract';
import { createHubDispatcher, DEFAULT_DISPATCH_TIMEOUT_MS, type HubDispatcherDeps } from './hub-dispatch.ts';
import type { PlacementCandidate, PlacementRequest } from './placement.ts';
import type { ClusterLinkServer } from './link-server.ts';

/**
 * Milestone C steps 1+2 and decision C-f (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`) —
 * the hub's dispatch emitter (`createHubDispatcher#dispatch`) and its correlation store
 * (`recordFreshnessReply`/`get`/`listPending`/`sweepUnanswered`). Verifies exactly the five things
 * the implementation report was asked to prove: (a) local placement sends no frame; (b) remote
 * placement sends exactly one frame, to the chosen node, and it validates against the wire schema;
 * (c) a refused reply resolves as refused with its reason, an accepted reply resolves as accepted;
 * (d) an unmatched or already-resolved reply is not silently swallowed; (e) an unanswered dispatch
 * reaches a named terminal state.
 *
 * `placeRun`/`buildDispatch` are exercised for real (both are pure, both already fully covered by
 * `placement.test.ts`/`dispatch.test.ts`) — nothing here re-tests placement ranking or refusal
 * logic, only that this module calls them correctly and wires the result to the link and the store.
 */

// ---- fixtures --------------------------------------------------------------------------------

function capacity(overrides: Partial<ClusterCapacity> = {}): ClusterCapacity {
  return { maxParallel: 8, active: 0, heavyActive: 0, enforcement: 'cgroup', ...overrides };
}

function candidate(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    nodeId: 'node-b',
    labels: [],
    acceptsDispatch: true,
    online: true,
    capacity: capacity(),
    holdsProject: true,
    ...overrides,
  };
}

function activeRun(overrides: Partial<ClusterActiveRun> = {}): ClusterActiveRun {
  return { runId: 'run-1', nodeId: 'node-b', projectKey: 'proj-1', paths: [], ...overrides };
}

function request(overrides: Partial<PlacementRequest> = {}): PlacementRequest {
  return { projectKey: 'proj-1', projectHasOrigin: true, ...overrides };
}

function freshnessFrame(overrides: Partial<ClusterFreshnessFrame> = {}): ClusterFreshnessFrame {
  return {
    type: 'freshness',
    protocol: CLUSTER_PROTOCOL,
    projectKey: 'proj-1',
    headSha: 'a'.repeat(40),
    ahead: 0,
    behind: 0,
    dirty: 0,
    merging: false,
    ...overrides,
  };
}

/** Mirrors `cluster-hub-replication.test.ts`'s own `fakeLink` — a plain object with just the one
 *  method this module calls, returned through the getter cast `as never` at the call site, the
 *  same way `buildHubReplication`'s own tests fake `ClusterLinkServer` without a real socket. */
function fakeLinkServer(sendImpl?: (nodeId: string, frame: unknown) => boolean) {
  const sent: Array<[string, unknown]> = [];
  const send = vi.fn((nodeId: string, frame: unknown) => {
    sent.push([nodeId, frame]);
    return sendImpl ? sendImpl(nodeId, frame) : true;
  });
  return { sent, send, server: { send } as unknown as ClusterLinkServer };
}

function makeDeps(overrides: Partial<HubDispatcherDeps> & { linkServer?: HubDispatcherDeps['linkServer'] } = {}): HubDispatcherDeps {
  return {
    hubNodeId: 'hub-1',
    linkServer: () => undefined,
    warn: vi.fn(),
    ...overrides,
  };
}

// ---- dispatch — local placement (Verification a) ---------------------------------------------

describe('createHubDispatcher — dispatch, local placement', () => {
  it('a placement that lands on this hub sends NO frame', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));

    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'hub-1' })], // only the hub itself is eligible
      workflow: { builtinId: 'quick-task' },
    });

    expect(result.placement).toEqual({ status: 'placed', nodeId: 'hub-1' });
    expect(result.dispatch).toBeUndefined();
    expect(link.send).not.toHaveBeenCalled();
    expect(dispatcher.listPending()).toEqual([]);
  });
});

// ---- dispatch — remote placement (Verification b) ---------------------------------------------

describe('createHubDispatcher — dispatch, remote placement', () => {
  it('sends exactly one frame, to the node placeRun chose, and it validates against the wire schema', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })], // hub is not even a candidate here
      workflow: { builtinId: 'quick-task' },
      expectHeadSha: 'b'.repeat(40),
    });

    expect(result.placement).toEqual({ status: 'placed', nodeId: 'node-b' });
    expect(result.dispatch).toEqual({ dispatchId: expect.any(String), nodeId: 'node-b', sent: true });

    expect(link.send).toHaveBeenCalledTimes(1);
    const [sentTo, sentFrame] = link.sent[0]!;
    expect(sentTo).toBe('node-b');
    expect(() => clusterDispatchFrameSchema.parse(sentFrame)).not.toThrow();
    expect((sentFrame as { dispatchId: string }).dispatchId).toBe(result.dispatch?.dispatchId);
    expect((sentFrame as { todoId: string }).todoId).toBe('todo-1');
    expect((sentFrame as { expect?: { headSha: string } }).expect).toEqual({ headSha: 'b'.repeat(40) });

    // Recorded as pending, keyed on the dispatchId the frame itself carries.
    const record = dispatcher.get(result.dispatch!.dispatchId);
    expect(record?.status).toBe('pending');
    expect(record?.nodeId).toBe('node-b');
    expect(record?.todoId).toBe('todo-1');
    expect(dispatcher.listPending().map((r) => r.dispatchId)).toEqual([result.dispatch!.dispatchId]);
  });

  it('records the attempt as pending even when the link cannot deliver it right now (node offline)', async () => {
    const link = fakeLinkServer(() => false); // simulates "node not connected"
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));

    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(result.dispatch?.sent).toBe(false);
    expect(dispatcher.get(result.dispatch!.dispatchId)?.status).toBe('pending');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be sent'));
  });
});

// ---- dispatch — blocked/queued never reach the link --------------------------------------------

describe('createHubDispatcher — dispatch, non-placed outcomes', () => {
  it('a blocked placement (D19 rung 3 overlap) sends no frame', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request({ touchedPaths: ['src/cluster/'], activeRuns: [activeRun({ paths: ['src/cluster/ops.ts'] })] }),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(result.placement?.status).toBe('blocked');
    expect(result.dispatch).toBeUndefined();
    expect(link.send).not.toHaveBeenCalled();
  });

  it('a queued placement (every eligible node at capacity) sends no frame', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b', capacity: capacity({ maxParallel: 1, active: 1 }) })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(result.placement?.status).toBe('queued');
    expect(result.dispatch).toBeUndefined();
    expect(link.send).not.toHaveBeenCalled();
  });
});

// ---- dispatch — in-flight accounting between presence beats (placement hot-spot, spec "6. The
// placement hot-spot is CONFIRMED") --------------------------------------------------------------
//
// `placement.test.ts` cannot express this defect: `placeRun` is pure and stateless, so it has no
// way to see a hub's own PRIOR dispatches. It can only be proven here, at the dispatcher level,
// across multiple `dispatch()` calls sharing one `records` map.

describe('createHubDispatcher — dispatch, in-flight accounting between presence beats', () => {
  it('spreads six distinct todos across two candidates with DIFFERENT loads held constant for the whole window (no beat between dispatches)', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    // node-a starts strictly less loaded than node-b — load-bearing (see this describe block's
    // comment): with both at `active: 0` the tiebreak alone would legitimately pin node-a, and
    // the assertions below would be asserting the wrong thing for the wrong reason.
    const candidates: PlacementCandidate[] = [
      candidate({ nodeId: 'node-a', capacity: capacity({ maxParallel: 8, active: 0 }) }),
      candidate({ nodeId: 'node-b', capacity: capacity({ maxParallel: 8, active: 1 }) }),
    ];

    const byNode: Record<string, number> = {};
    for (let i = 0; i < 6; i++) {
      const result = await dispatcher.dispatch({
        todoId: `todo-${i}`,
        request: request(),
        candidates, // the SAME candidates, unchanged — one presence window, no beat in between
        workflow: { builtinId: 'quick-task' },
      });
      expect(result.placement?.status).toBe('placed');
      const nodeId = result.dispatch!.nodeId;
      byNode[nodeId] = (byNode[nodeId] ?? 0) + 1;
    }

    // Pre-fix this is `{"node-a": 6}` — every placement after the first sees the same
    // byte-identical candidates as the first, because nothing folds this hub's own pending
    // dispatches back into `active`.
    expect(byNode['node-b'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(Object.values(byNode).some((count) => count === 6)).toBe(false);
  });

  it('mirror control: a SINGLE todo against the same roster still lands on node-a, the genuinely less-loaded candidate', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    const candidates: PlacementCandidate[] = [
      candidate({ nodeId: 'node-a', capacity: capacity({ maxParallel: 8, active: 0 }) }),
      candidate({ nodeId: 'node-b', capacity: capacity({ maxParallel: 8, active: 1 }) }),
    ];

    const result = await dispatcher.dispatch({
      todoId: 'todo-only',
      request: request(),
      candidates,
      workflow: { builtinId: 'quick-task' },
    });

    // Proves the spread above comes from in-flight accounting, not from a broken ranking: with
    // nothing yet pending, the genuinely less-loaded node still wins outright.
    expect(result.dispatch?.nodeId).toBe('node-a');
  });
});

// ---- recordFreshnessReply — refusal path (Verification c) --------------------------------------

describe('createHubDispatcher — recordFreshnessReply, refusal', () => {
  async function dispatchTo(nodeId: string, deps: HubDispatcherDeps) {
    const dispatcher = createHubDispatcher(deps);
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId })],
      workflow: { builtinId: 'quick-task' },
    });
    return { dispatcher, dispatchId: result.dispatch!.dispatchId };
  }

  it('a refused reply resolves the pending dispatch as refused, with the reason and detail', async () => {
    const link = fakeLinkServer();
    const { dispatcher, dispatchId } = await dispatchTo('node-b', makeDeps({ linkServer: () => link.server }));

    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ refused: { dispatchId, reason: 'behind', detail: '3 commits behind' } }),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ dispatchId, status: 'refused', refusal: { reason: 'behind', detail: '3 commits behind' } });
    expect(resolved[0]?.resolvedAt).toEqual(expect.any(String));
    expect(dispatcher.get(dispatchId)?.status).toBe('refused');
    expect(dispatcher.listPending()).toEqual([]);
  });

  it('a refusal carries no detail when the wire frame carried none', async () => {
    const link = fakeLinkServer();
    const { dispatcher, dispatchId } = await dispatchTo('node-b', makeDeps({ linkServer: () => link.server }));

    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ refused: { dispatchId, reason: 'at-capacity' } }),
    );

    expect(resolved[0]?.refusal).toEqual({ reason: 'at-capacity' });
    expect('detail' in (resolved[0]?.refusal ?? {})).toBe(false);
  });
});

// ---- recordFreshnessReply — acceptance path (Verification c, continued) ------------------------

describe('createHubDispatcher — recordFreshnessReply, acceptance', () => {
  it('an `accepted` block resolves the matching pending dispatch as accepted, carrying the runId', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request({ projectKey: 'proj-1' }),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ dispatchId, status: 'accepted', runId: 'run-1' });
    expect(resolved[0]?.resolvedAt).toEqual(expect.any(String));
    expect(dispatcher.get(dispatchId)).toMatchObject({ status: 'accepted', runId: 'run-1' });
    expect(dispatcher.listPending()).toEqual([]);
  });

  it('negative control: a routine freshness beat with neither `accepted` nor `refused` resolves nothing and does not warn', () => {
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ warn }));

    const resolved = dispatcher.recordFreshnessReply('node-b', freshnessFrame({ projectKey: 'proj-1' }));

    expect(resolved).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('two pending dispatches to the same (nodeId, projectKey) are each resolved independently, because acceptance carries its own dispatchId (D48)', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));
    const first = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request({ projectKey: 'proj-1' }),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const second = await dispatcher.dispatch({
      todoId: 'todo-2',
      request: request({ projectKey: 'proj-1' }),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    expect(first.dispatch!.dispatchId).not.toBe(second.dispatch!.dispatchId);

    // Only the second dispatch's accept arrives. Nothing about the two sharing (nodeId, projectKey)
    // touches the first — exact `dispatchId` correlation means there is nothing left to disambiguate.
    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ projectKey: 'proj-1', accepted: { dispatchId: second.dispatch!.dispatchId, runId: 'run-2' } }),
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ dispatchId: second.dispatch!.dispatchId, status: 'accepted', runId: 'run-2' });
    expect(dispatcher.get(first.dispatch!.dispatchId)?.status).toBe('pending');
    expect(dispatcher.get(second.dispatch!.dispatchId)?.status).toBe('accepted');
    expect(warn).not.toHaveBeenCalled();

    // The first dispatch's own accept, arriving separately, resolves it too — independently.
    const resolvedFirst = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ projectKey: 'proj-1', accepted: { dispatchId: first.dispatch!.dispatchId, runId: 'run-1' } }),
    );
    expect(resolvedFirst).toHaveLength(1);
    expect(dispatcher.get(first.dispatch!.dispatchId)).toMatchObject({ status: 'accepted', runId: 'run-1' });
  });
});

// ---- recordFreshnessReply — unmatched / stale replies are not silently swallowed (Verification d) ----

describe('createHubDispatcher — recordFreshnessReply, unmatched replies', () => {
  it('a refusal whose dispatchId matches no pending record warns and resolves nothing', () => {
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ warn }));

    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ refused: { dispatchId: 'dispatch-unknown', reason: 'dirty' } }),
    );

    expect(resolved).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispatch-unknown'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no PENDING record'));
  });

  it('a refusal for a dispatch already resolved is not re-resolved (no flip-flopping status)', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request({ projectKey: 'proj-1' }),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    // Accepted first.
    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }));
    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');

    // A late/duplicate refusal for the same id must not overwrite the accepted verdict.
    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ refused: { dispatchId, reason: 'dirty' } }),
    );
    expect(resolved).toEqual([]);
    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');
  });

  it('an accept for a dispatch already resolved (e.g. a duplicate/replayed accept) is not re-resolved', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request({ projectKey: 'proj-1' }),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ refused: { dispatchId, reason: 'dirty' } }));
    expect(dispatcher.get(dispatchId)?.status).toBe('refused');

    // A late/duplicate accept for the same id must not overwrite the refused verdict.
    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }),
    );
    expect(resolved).toEqual([]);
    expect(dispatcher.get(dispatchId)?.status).toBe('refused');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(dispatchId));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no PENDING record'));
  });

  it('an accept whose sender does not match the node the dispatch was addressed to is not resolved', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    const resolved = dispatcher.recordFreshnessReply(
      'node-c', // dispatch was addressed to node-b
      freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }),
    );

    expect(resolved).toEqual([]);
    expect(dispatcher.get(dispatchId)?.status).toBe('pending');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('node-c'));
  });

  it('an accept whose dispatchId matches no pending record warns and resolves nothing', () => {
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ warn }));

    const resolved = dispatcher.recordFreshnessReply(
      'node-b',
      freshnessFrame({ accepted: { dispatchId: 'dispatch-unknown', runId: 'run-1' } }),
    );

    expect(resolved).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispatch-unknown'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no PENDING record'));
  });

  it('a refusal whose sender does not match the node the dispatch was addressed to is refused as suspicious, not resolved', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    const resolved = dispatcher.recordFreshnessReply(
      'node-c', // dispatch was addressed to node-b
      freshnessFrame({ refused: { dispatchId, reason: 'dirty' } }),
    );

    expect(resolved).toEqual([]);
    expect(dispatcher.get(dispatchId)?.status).toBe('pending');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('node-c'));
  });
});

// ---- sweepUnanswered — the terminal state for a dispatch nobody answers (Verification e) -------

describe('createHubDispatcher — sweepUnanswered', () => {
  it('moves a pending dispatch older than the timeout to `unanswered`', async () => {
    const link = fakeLinkServer();
    let clock = new Date('2026-08-23T00:00:00.000Z');
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, now: () => clock }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    clock = new Date(clock.getTime() + DEFAULT_DISPATCH_TIMEOUT_MS + 1);
    const expired = dispatcher.sweepUnanswered();

    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ dispatchId, status: 'unanswered' });
    expect(dispatcher.get(dispatchId)?.status).toBe('unanswered');
    expect(dispatcher.listPending()).toEqual([]);
  });

  it('negative control: a pending dispatch within the timeout is left alone', async () => {
    const link = fakeLinkServer();
    let clock = new Date('2026-08-23T00:00:00.000Z');
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, now: () => clock }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    clock = new Date(clock.getTime() + DEFAULT_DISPATCH_TIMEOUT_MS - 1);
    const expired = dispatcher.sweepUnanswered();

    expect(expired).toEqual([]);
    expect(dispatcher.get(dispatchId)?.status).toBe('pending');
  });

  it('does not touch an already-resolved dispatch, even long past the timeout', async () => {
    const link = fakeLinkServer();
    let clock = new Date('2026-08-23T00:00:00.000Z');
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, now: () => clock }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request({ projectKey: 'proj-1' }),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;
    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }));
    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');

    clock = new Date(clock.getTime() + DEFAULT_DISPATCH_TIMEOUT_MS * 100);
    const expired = dispatcher.sweepUnanswered();

    expect(expired).toEqual([]);
    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');
  });

  it('honours a caller-supplied timeoutMs instead of the default', async () => {
    const link = fakeLinkServer();
    let clock = new Date('2026-08-23T00:00:00.000Z');
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, now: () => clock }));
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = result.dispatch!.dispatchId;

    clock = new Date(clock.getTime() + 5_000);
    expect(dispatcher.sweepUnanswered({ timeoutMs: 1_000 })).toHaveLength(1);
    expect(dispatcher.get(dispatchId)?.status).toBe('unanswered');
  });
});

// ---- deps.onAccepted — the C-a2 stamp seam (fires exactly on resolved acceptance) --------------

describe('createHubDispatcher — onAccepted (C-a2 stamp seam)', () => {
  async function dispatchTo(nodeId: string, deps: Omit<HubDispatcherDeps, 'hubNodeId'> & Partial<Pick<HubDispatcherDeps, 'hubNodeId'>>) {
    const dispatcher = createHubDispatcher({ hubNodeId: 'hub-1', ...deps });
    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId })],
      workflow: { builtinId: 'quick-task' },
    });
    return { dispatcher, dispatchId: result.dispatch!.dispatchId };
  }

  it('fires exactly once, with the fully-resolved record (including runId), on a successful acceptance', async () => {
    const link = fakeLinkServer();
    const onAccepted = vi.fn();
    const { dispatcher, dispatchId } = await dispatchTo('node-b', { linkServer: () => link.server, onAccepted });

    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-7' } }));
    // onAccepted is fired via a `void Promise.resolve(...).catch(...)` — let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ dispatchId, status: 'accepted', runId: 'run-7' }));
  });

  it('does not fire on a refusal', async () => {
    const link = fakeLinkServer();
    const onAccepted = vi.fn();
    const { dispatcher, dispatchId } = await dispatchTo('node-b', { linkServer: () => link.server, onAccepted });

    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ refused: { dispatchId, reason: 'dirty' } }));
    await Promise.resolve();

    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('does not fire on a routine freshness beat that matches nothing', async () => {
    const onAccepted = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ onAccepted }));

    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ projectKey: 'proj-1' }));
    await Promise.resolve();

    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('does not fire on an unmatched or already-resolved accept', async () => {
    const link = fakeLinkServer();
    const onAccepted = vi.fn();
    const { dispatcher, dispatchId } = await dispatchTo('node-b', { linkServer: () => link.server, onAccepted });

    // Resolve it once (consumes the pending record)...
    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }));
    await Promise.resolve();
    onAccepted.mockClear();

    // ...then a duplicate/replayed accept for the same id must not fire it again.
    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }));
    await Promise.resolve();

    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('a synchronous throw inside onAccepted is caught and warned, not propagated, and the record still resolves', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const onAccepted = vi.fn(() => {
      throw new Error('boom-sync');
    });
    const { dispatcher, dispatchId } = await dispatchTo('node-b', { linkServer: () => link.server, warn, onAccepted });

    expect(() =>
      dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } })),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(dispatchId));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom-sync'));
  });

  it('an async rejection from onAccepted is caught and warned, not left unhandled, and the record still resolves', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const onAccepted = vi.fn(async () => {
      throw new Error('boom-async');
    });
    const { dispatcher, dispatchId } = await dispatchTo('node-b', { linkServer: () => link.server, warn, onAccepted });

    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }));
    // Let the rejected promise's `.catch` handler run.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(dispatchId));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom-async'));
  });

  it('negative control: with no onAccepted supplied, a normal acceptance still resolves without error', async () => {
    const link = fakeLinkServer();
    const { dispatcher, dispatchId } = await dispatchTo('node-b', { linkServer: () => link.server });

    expect(() =>
      dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } })),
    ).not.toThrow();
    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');
  });
});

// ---- dispatch — duplicate-dispatch guard (C-a3) -------------------------------------------------

describe('createHubDispatcher — dispatch, duplicate-dispatch guard (C-a3)', () => {
  it('a second dispatch for a todoId with an outstanding PENDING attempt is declined, not sent', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));

    const first = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    expect(first.dispatch?.sent).toBe(true);

    const second = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-c' })], // even a different, otherwise-eligible node
      workflow: { builtinId: 'quick-task' },
    });

    expect(second.placement).toBeUndefined();
    expect(second.dispatch).toBeUndefined();
    expect(second.declined).toMatchObject({ reason: 'already-dispatched' });
    expect(second.declined?.existing.dispatchId).toBe(first.dispatch!.dispatchId);
    expect(second.declined?.existing.status).toBe('pending');

    // Only the first dispatch ever reached the link.
    expect(link.send).toHaveBeenCalledTimes(1);
    expect(dispatcher.listPending()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('todo-1'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(first.dispatch!.dispatchId));
  });

  it('a second dispatch for a todoId with an outstanding ACCEPTED attempt is declined too', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    const first = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = first.dispatch!.dispatchId;
    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ accepted: { dispatchId, runId: 'run-1' } }));
    expect(dispatcher.get(dispatchId)?.status).toBe('accepted');

    const second = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-c' })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(second.declined).toMatchObject({ reason: 'already-dispatched' });
    expect(second.declined?.existing.status).toBe('accepted');
    expect(second.declined?.existing.runId).toBe('run-1');
    expect(link.send).toHaveBeenCalledTimes(1); // still just the first
  });

  it('negative control: a dispatch for a DIFFERENT todoId to the same node still goes through while the first is pending', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    const first = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    expect(first.dispatch?.sent).toBe(true);

    const second = await dispatcher.dispatch({
      todoId: 'todo-2', // different todo, same node
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(second.declined).toBeUndefined();
    expect(second.dispatch?.sent).toBe(true);
    expect(link.send).toHaveBeenCalledTimes(2);
    expect(dispatcher.listPending()).toHaveLength(2);
  });

  it('a second dispatch for the same todoId is allowed again once the first reached `refused` (terminal, not blocking)', async () => {
    const link = fakeLinkServer();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server }));

    const first = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = first.dispatch!.dispatchId;
    dispatcher.recordFreshnessReply('node-b', freshnessFrame({ refused: { dispatchId, reason: 'dirty' } }));
    expect(dispatcher.get(dispatchId)?.status).toBe('refused');

    const second = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(second.declined).toBeUndefined();
    expect(second.dispatch?.sent).toBe(true);
    expect(second.dispatch?.dispatchId).not.toBe(dispatchId);
  });

  it('a second dispatch for the same todoId is allowed again once the first reached `unanswered` via sweepUnanswered (terminal, not blocking)', async () => {
    const link = fakeLinkServer();
    let clock = new Date('2026-08-23T00:00:00.000Z');
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, now: () => clock }));

    const first = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });
    const dispatchId = first.dispatch!.dispatchId;

    clock = new Date(clock.getTime() + DEFAULT_DISPATCH_TIMEOUT_MS + 1);
    dispatcher.sweepUnanswered();
    expect(dispatcher.get(dispatchId)?.status).toBe('unanswered');

    const second = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(second.declined).toBeUndefined();
    expect(second.dispatch?.sent).toBe(true);
    expect(second.dispatch?.dispatchId).not.toBe(dispatchId);
  });

  it('negative control: with no prior dispatch for this todoId at all, nothing is declined', async () => {
    const link = fakeLinkServer();
    const warn = vi.fn();
    const dispatcher = createHubDispatcher(makeDeps({ linkServer: () => link.server, warn }));

    const result = await dispatcher.dispatch({
      todoId: 'todo-1',
      request: request(),
      candidates: [candidate({ nodeId: 'node-b' })],
      workflow: { builtinId: 'quick-task' },
    });

    expect(result.declined).toBeUndefined();
    expect(result.dispatch?.sent).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });
});
