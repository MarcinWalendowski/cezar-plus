import { describe, expect, it } from 'vitest';
import { clusterQueuedReasonSchema } from '@loki-labs/better-cezar-contract';
import type { ClusterActiveRun, ClusterCapacity } from '@loki-labs/better-cezar-contract';
import {
  eligibleCandidates,
  headroom,
  overlappingRun,
  placeRun,
  type PlacementCandidate,
  type PlacementRequest,
} from './placement.ts';

/**
 * Package 4.1 (`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`), covering spec Verification
 * 6 / 6a / 6b. `placement.ts` is pure, so every fixture below is plain data — no server, no clock,
 * no filesystem.
 */

function capacity(overrides: Partial<ClusterCapacity> = {}): ClusterCapacity {
  return {
    maxParallel: 8,
    active: 0,
    heavyActive: 0,
    enforcement: 'cgroup',
    ...overrides,
  };
}

function candidate(overrides: Partial<PlacementCandidate> = {}): PlacementCandidate {
  return {
    nodeId: 'node-a',
    labels: [],
    acceptsDispatch: true,
    online: true,
    capacity: capacity(),
    holdsProject: true,
    ...overrides,
  };
}

function activeRun(overrides: Partial<ClusterActiveRun> = {}): ClusterActiveRun {
  return {
    runId: 'run-1',
    nodeId: 'node-a',
    projectKey: 'proj-1',
    paths: [],
    ...overrides,
  };
}

function request(overrides: Partial<PlacementRequest> = {}): PlacementRequest {
  return {
    projectKey: 'proj-1',
    projectHasOrigin: true,
    ...overrides,
  };
}

describe('headroom', () => {
  it('is maxParallel - active for the parallel figure', () => {
    expect(headroom(capacity({ maxParallel: 8, active: 3 })).parallel).toBe(5);
  });

  it('is maxHeavySteps - heavyActive for the heavy figure when maxHeavySteps is set', () => {
    expect(headroom(capacity({ maxHeavySteps: 2, heavyActive: 1 })).heavy).toBe(1);
  });

  it('treats an absent maxHeavySteps as unbounded, not zero (predates D14)', () => {
    const h = headroom(capacity({ maxHeavySteps: undefined, heavyActive: 5 }));
    expect(h.heavy).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('eligibleCandidates', () => {
  it('excludes a node that has not opted into dispatch (D11)', () => {
    const nodes = [candidate({ nodeId: 'a', acceptsDispatch: false })];
    expect(eligibleCandidates(request(), nodes)).toEqual([]);
  });

  it('excludes an offline node — asleep is a state, not a placement target', () => {
    const nodes = [candidate({ nodeId: 'a', online: false })];
    expect(eligibleCandidates(request(), nodes)).toEqual([]);
  });

  it('narrows to nodes carrying every required label', () => {
    const withLabel = candidate({ nodeId: 'a', labels: ['macos', 'imessage'] });
    const withoutLabel = candidate({ nodeId: 'b', labels: ['macos'] });
    const req = request({ placement: { requires: ['macos', 'imessage'] } });
    expect(eligibleCandidates(req, [withLabel, withoutLabel]).map((c) => c.nodeId)).toEqual(['a']);
  });

  it('narrows to exactly the pinned node when placement.node is set', () => {
    const a = candidate({ nodeId: 'a' });
    const b = candidate({ nodeId: 'b' });
    const req = request({ placement: { node: 'b' } });
    expect(eligibleCandidates(req, [a, b]).map((c) => c.nodeId)).toEqual(['b']);
  });

  it('narrows to the node(s) holding the project when it has no origin (D12)', () => {
    const holder = candidate({ nodeId: 'holder', holdsProject: true });
    const peer = candidate({ nodeId: 'peer', holdsProject: false });
    const req = request({ projectHasOrigin: false });
    expect(eligibleCandidates(req, [holder, peer]).map((c) => c.nodeId)).toEqual(['holder']);
  });
});

describe('overlappingRun', () => {
  it('cannot run and must not pretend it did when touchedPaths is absent', () => {
    const req = request({ touchedPaths: undefined });
    expect(overlappingRun(req, [activeRun({ paths: ['src/index.ts'] })])).toBeUndefined();
  });

  it('finds the active run in the same project touching an overlapping path', () => {
    const req = request({ projectKey: 'proj-1', touchedPaths: ['src/index.ts'] });
    const run = activeRun({ projectKey: 'proj-1', paths: ['src/index.ts', 'src/other.ts'] });
    expect(overlappingRun(req, [run])).toBe(run);
  });

  it('does not match a run in a different project even with an identical path', () => {
    const req = request({ projectKey: 'proj-1', touchedPaths: ['src/index.ts'] });
    const run = activeRun({ projectKey: 'proj-2', paths: ['src/index.ts'] });
    expect(overlappingRun(req, [run])).toBeUndefined();
  });

  it('matches a directory in one run against a file beneath it in the other (segment-prefix overlap)', () => {
    const req = request({ projectKey: 'proj-1', touchedPaths: ['src/cluster/ops.ts'] });
    const run = activeRun({ projectKey: 'proj-1', paths: ['src/cluster'] });
    expect(overlappingRun(req, [run])).toBe(run);
  });

  it('negative control: sibling paths sharing a textual prefix but not a segment boundary do not overlap', () => {
    const req = request({ projectKey: 'proj-1', touchedPaths: ['src/cluster-section.tsx'] });
    const run = activeRun({ projectKey: 'proj-1', paths: ['src/cluster'] });
    expect(overlappingRun(req, [run])).toBeUndefined();
  });
});

describe('placeRun', () => {
  it('6 — unmet requires queues with a reason naming the node, and never starts', () => {
    const nodes = [candidate({ nodeId: 'a', labels: ['macos'] })];
    const req = request({ placement: { requires: ['browser'] } });
    const result = placeRun(req, nodes);
    expect(result).toEqual({
      status: 'queued',
      reason: 'no-node-with-label',
      detail: 'browser',
    });
  });

  it('defaults to the eligible node with the most headroom, not the authoring/first node (D12)', () => {
    const loaded = candidate({ nodeId: 'loaded', capacity: capacity({ maxParallel: 8, active: 6 }) });
    const idle = candidate({ nodeId: 'idle', capacity: capacity({ maxParallel: 8, active: 0 }) });
    // `loaded` is listed first — a naive "first candidate" default would pick it.
    const result = placeRun(request(), [loaded, idle]);
    expect(result).toEqual({ status: 'placed', nodeId: 'idle' });
  });

  it('ties on parallel headroom break on nodeId, deterministically', () => {
    const b = candidate({ nodeId: 'b', capacity: capacity({ active: 2 }) });
    const a = candidate({ nodeId: 'a', capacity: capacity({ active: 2 }) });
    expect(placeRun(request(), [b, a])).toEqual({ status: 'placed', nodeId: 'a' });
  });

  it('an explicit node pin that is offline queues with pinned-node-offline', () => {
    const pinned = candidate({ nodeId: 'target', online: false });
    const other = candidate({ nodeId: 'other' });
    const req = request({ placement: { node: 'target' } });
    expect(placeRun(req, [pinned, other])).toEqual({
      status: 'queued',
      reason: 'pinned-node-offline',
      detail: 'target',
    });
  });

  it('an explicit node pin that exists but is not opted into dispatch also queues pinned-node-offline', () => {
    const pinned = candidate({ nodeId: 'target', acceptsDispatch: false });
    const req = request({ placement: { node: 'target' } });
    expect(placeRun(req, [pinned])).toEqual({
      status: 'queued',
      reason: 'pinned-node-offline',
      detail: 'target',
    });
  });

  it('an explicit node pin that is online but full queues all-eligible-at-capacity, not offline', () => {
    const pinned = candidate({
      nodeId: 'target',
      capacity: capacity({ maxParallel: 4, active: 4 }),
    });
    const req = request({ placement: { node: 'target' } });
    expect(placeRun(req, [pinned])).toEqual({
      status: 'queued',
      reason: 'all-eligible-at-capacity',
      detail: 'target',
    });
  });

  it('queues all-eligible-at-capacity when every eligible node is full', () => {
    const a = candidate({ nodeId: 'a', capacity: capacity({ maxParallel: 4, active: 4 }) });
    const b = candidate({ nodeId: 'b', capacity: capacity({ maxParallel: 2, active: 2 }) });
    expect(placeRun(request(), [a, b])).toEqual({
      status: 'queued',
      reason: 'all-eligible-at-capacity',
      detail: undefined,
    });
  });

  describe('6a — a remote-less project is pinned to its holding node (D12)', () => {
    it('never places off the holding node, even when it is more loaded than an idle peer', () => {
      const holder = candidate({
        nodeId: 'holder',
        holdsProject: true,
        capacity: capacity({ maxParallel: 4, active: 3 }), // loaded, but not full: headroom 1
      });
      const peer = candidate({
        nodeId: 'peer',
        holdsProject: false,
        capacity: capacity({ maxParallel: 8, active: 0 }), // idle: headroom 8
      });
      const req = request({ projectHasOrigin: false });
      // Least-loaded would pick `peer` outright; the origin rule must override that.
      expect(placeRun(req, [holder, peer])).toEqual({ status: 'placed', nodeId: 'holder' });
    });

    it('negative control: the SAME fixture WITH an origin does get placed on the idle peer', () => {
      const holder = candidate({
        nodeId: 'holder',
        holdsProject: true,
        capacity: capacity({ maxParallel: 4, active: 3 }),
      });
      const peer = candidate({
        nodeId: 'peer',
        holdsProject: false,
        capacity: capacity({ maxParallel: 8, active: 0 }),
      });
      const req = request({ projectHasOrigin: true });
      // Proves the rule above is not vacuous: with an origin, placement actually moves to the peer.
      expect(placeRun(req, [holder, peer])).toEqual({ status: 'placed', nodeId: 'peer' });
    });

    it('reports queuedReason project-has-no-origin, not all-eligible-at-capacity, when the holding node is full', () => {
      const holder = candidate({
        nodeId: 'holder',
        holdsProject: true,
        capacity: capacity({ maxParallel: 4, active: 4 }), // full
      });
      const peer = candidate({
        nodeId: 'peer',
        holdsProject: false,
        capacity: capacity({ maxParallel: 8, active: 0 }), // idle, but does not hold the project
      });
      const req = request({ projectHasOrigin: false });
      expect(placeRun(req, [holder, peer])).toEqual({
        status: 'queued',
        reason: 'project-has-no-origin',
        detail: 'proj-1',
      });
    });

    it('negative control: with an origin present, the same full-holder fixture places on the peer instead of queueing', () => {
      const holder = candidate({
        nodeId: 'holder',
        holdsProject: true,
        capacity: capacity({ maxParallel: 4, active: 4 }),
      });
      const peer = candidate({
        nodeId: 'peer',
        holdsProject: false,
        capacity: capacity({ maxParallel: 8, active: 0 }),
      });
      const req = request({ projectHasOrigin: true });
      expect(placeRun(req, [holder, peer])).toEqual({ status: 'placed', nodeId: 'peer' });
    });
  });

  describe('6b — overlap refusal names the other run (D19 rung 3)', () => {
    it('queues and names the other run when an active run in this project overlaps a touched path, even when it is not first in activeRuns', () => {
      const decoy = activeRun({
        runId: 'r_decoy',
        nodeId: 'worker-1',
        projectKey: 'proj-1',
        paths: ['packages/cezar/src/cluster/dispatch.ts'],
      });
      const conflicting = activeRun({
        runId: 'r_holding',
        nodeId: 'worker-2',
        projectKey: 'proj-1',
        paths: ['packages/cezar/src/cluster/placement.ts'],
      });
      const req = request({
        projectKey: 'proj-1',
        touchedPaths: ['packages/cezar/src/cluster/placement.ts'],
        // `decoy` is listed first and does not overlap — a scan that only inspected
        // `activeRuns[0]` would miss `conflicting` entirely and place instead of block.
        activeRuns: [decoy, conflicting],
      });
      const nodes = [candidate({ nodeId: 'idle', capacity: capacity({ active: 0 }) })];
      expect(placeRun(req, nodes)).toEqual({ status: 'blocked', blockedBy: conflicting });
    });

    it('mirror control: the same fixture with the conflicting run listed first still names it (order is not what matters)', () => {
      const conflicting = activeRun({
        runId: 'r_holding',
        nodeId: 'worker-2',
        projectKey: 'proj-1',
        paths: ['packages/cezar/src/cluster/placement.ts'],
      });
      const decoy = activeRun({
        runId: 'r_decoy',
        nodeId: 'worker-1',
        projectKey: 'proj-1',
        paths: ['packages/cezar/src/cluster/dispatch.ts'],
      });
      const req = request({
        projectKey: 'proj-1',
        touchedPaths: ['packages/cezar/src/cluster/placement.ts'],
        activeRuns: [conflicting, decoy],
      });
      const nodes = [candidate({ nodeId: 'idle', capacity: capacity({ active: 0 }) })];
      expect(placeRun(req, nodes)).toEqual({ status: 'blocked', blockedBy: conflicting });
    });

    it('negative control: non-overlapping paths across multiple active runs in the same project still dispatch', () => {
      const otherA = activeRun({
        runId: 'r_holding_a',
        projectKey: 'proj-1',
        paths: ['packages/cezar/src/cluster/dispatch.ts'],
      });
      const otherB = activeRun({
        runId: 'r_holding_b',
        projectKey: 'proj-1',
        paths: ['packages/cezar/src/cluster/hub-dispatch.ts'],
      });
      const req = request({
        projectKey: 'proj-1',
        touchedPaths: ['packages/cezar/src/cluster/placement.ts'],
        // Two non-overlapping active runs, not one — a full scan that false-positives on
        // "any activeRuns present" rather than checking each one would wrongly block here.
        activeRuns: [otherA, otherB],
      });
      const nodes = [candidate({ nodeId: 'idle', capacity: capacity({ active: 0 }) })];
      expect(placeRun(req, nodes)).toEqual({ status: 'placed', nodeId: 'idle' });
    });

    it('negative control: an overlapping run that has finished (absent from activeRuns) does not block', () => {
      // ClusterActiveRun carries no status field by design — presence IS "active". A finished run
      // is simply not in the list any more, so `activeRuns` here is what it would look like after
      // the conflicting run completed and dropped out.
      const req = request({
        projectKey: 'proj-1',
        touchedPaths: ['packages/cezar/src/cluster/placement.ts'],
        activeRuns: [],
      });
      const nodes = [candidate({ nodeId: 'idle', capacity: capacity({ active: 0 }) })];
      expect(placeRun(req, nodes)).toEqual({ status: 'placed', nodeId: 'idle' });
    });
  });
});

describe('the four queued reasons', () => {
  it('are pairwise distinct — a fifth reason reusing an existing value must fail this', () => {
    const reasons = clusterQueuedReasonSchema.options;
    expect(reasons).toHaveLength(4);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
