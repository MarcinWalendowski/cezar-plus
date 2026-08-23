import { describe, expect, it } from 'vitest';
import { CLUSTER_OPS_PER_FRAME_MAX, type ClusterOp } from '@loki-labs/better-cezar-contract';
import { planReplicaFanout, type ReplicaFanoutTarget } from './replica-fanout.ts';

/**
 * `cluster/replica-fanout.ts` — the SENDING half of replication, the counterpart to
 * `replica.test.ts`'s coverage of the receiving half. Verifies the module docblock's five
 * requirements: the frame cap, the watermark filter, "no frame when nothing is owed", frame
 * ordering, and the origin-node decision — each with a mutation-tested guard (see the session
 * report for the mutation-testing transcript; this file is what stayed red under each mutation).
 */

type AppliedOp = ClusterOp & { hubSeq: number };

function makeOp(fields: {
  entityId: string;
  hubSeq: number;
  nodeId?: string;
  op?: 'upsert' | 'tombstone';
  content?: Record<string, unknown>;
}): AppliedOp {
  return {
    opId: `op-${fields.entityId}-${fields.hubSeq}`,
    nodeId: fields.nodeId ?? 'node-origin',
    ts: '2026-08-23T00:00:00.000Z',
    scope: 'project',
    projectKey: 'proj-1',
    entity: 'todo',
    entityId: fields.entityId,
    op: fields.op ?? 'upsert',
    fields: fields.content ?? { priority: 'high' },
    hubSeq: fields.hubSeq,
  };
}

function target(nodeId: string, appliedThroughHubSeq: number): ReplicaFanoutTarget {
  return { nodeId, appliedThroughHubSeq };
}

// ---- batching: the frame cap -------------------------------------------------------------------

describe('frame cap — more owed ops than CLUSTER_OPS_PER_FRAME_MAX split into several ascending frames', () => {
  it('splits into the right number of frames, each capped, ascending, each hubSeq its own max, nothing lost or duplicated', () => {
    const total = CLUSTER_OPS_PER_FRAME_MAX + 200;
    // Deliberately fed to `planReplicaFanout` in REVERSE hub order (a scrambled, not-yet-sorted
    // `applied` array is exactly what the contract on `ReplicaFanoutInput.applied` says to expect)
    // so this test also exercises the ordering requirement — a missing sort would silently pass a
    // count-only assertion but fail the exact-concatenation check below.
    const scrambled: AppliedOp[] = [];
    for (let hubSeq = total; hubSeq >= 1; hubSeq--) {
      scrambled.push(makeOp({ entityId: `t${hubSeq}`, hubSeq }));
    }
    const ascending = [...scrambled].sort((a, b) => a.hubSeq - b.hubSeq);

    const plans = planReplicaFanout({
      scope: 'project',
      projectKey: 'proj-1',
      applied: scrambled,
      targets: [target('node-b', 0)],
    });

    expect(plans).toHaveLength(1);
    const frames = plans[0]!.frames;
    expect(frames).toHaveLength(2);

    expect(frames[0]!.changes).toHaveLength(CLUSTER_OPS_PER_FRAME_MAX);
    expect(frames[0]!.hubSeq).toBe(CLUSTER_OPS_PER_FRAME_MAX);
    expect(frames[1]!.changes).toHaveLength(200);
    expect(frames[1]!.hubSeq).toBe(total);

    // The concatenation equals the input exactly, in hub order — no op lost, none duplicated,
    // none reordered across the split.
    const concatenated = frames.flatMap((f) => f.changes);
    expect(concatenated).toEqual(ascending);
  });

  it('one node with exactly the cap worth of ops gets exactly one frame', () => {
    const ops: AppliedOp[] = [];
    for (let hubSeq = 1; hubSeq <= CLUSTER_OPS_PER_FRAME_MAX; hubSeq++) {
      ops.push(makeOp({ entityId: `t${hubSeq}`, hubSeq }));
    }

    const plans = planReplicaFanout({ scope: 'project', applied: ops, targets: [target('node-b', 0)] });

    expect(plans[0]!.frames).toHaveLength(1);
    expect(plans[0]!.frames[0]!.changes).toHaveLength(CLUSTER_OPS_PER_FRAME_MAX);
    expect(plans[0]!.frames[0]!.hubSeq).toBe(CLUSTER_OPS_PER_FRAME_MAX);
  });
});

// ---- watermarks -----------------------------------------------------------------------------------

describe('watermarks — each target gets exactly the ops above its own, in hub order', () => {
  it('three targets at three watermarks each get exactly what they are owed; the caught-up one gets nothing', () => {
    const ops = [
      makeOp({ entityId: 't10', hubSeq: 10 }),
      makeOp({ entityId: 't20', hubSeq: 20 }),
      makeOp({ entityId: 't30', hubSeq: 30 }),
    ];

    const plans = planReplicaFanout({
      scope: 'project',
      applied: ops,
      targets: [
        target('node-fresh', 0), // owed all three
        target('node-mid', 20), // owed only hubSeq 30 — the boundary case: AT 20 is not owed
        target('node-caught-up', 30), // owed nothing at all
      ],
    });

    expect(plans).toHaveLength(2); // node-caught-up gets no plan entry at all — see next describe

    const fresh = plans.find((p) => p.nodeId === 'node-fresh');
    expect(fresh?.frames).toHaveLength(1);
    expect(fresh?.frames[0]?.changes.map((c) => c.entityId)).toEqual(['t10', 't20', 't30']);
    expect(fresh?.frames[0]?.hubSeq).toBe(30);

    const mid = plans.find((p) => p.nodeId === 'node-mid');
    expect(mid?.frames).toHaveLength(1);
    expect(mid?.frames[0]?.changes.map((c) => c.entityId)).toEqual(['t30']);
    expect(mid?.frames[0]?.hubSeq).toBe(30);

    expect(plans.find((p) => p.nodeId === 'node-caught-up')).toBeUndefined();
  });

  it('scope and projectKey are carried onto every frame unchanged', () => {
    const ops = [makeOp({ entityId: 't1', hubSeq: 1 })];
    const plans = planReplicaFanout({
      scope: 'workspace',
      applied: ops,
      targets: [target('node-a', 0)],
    });
    expect(plans[0]!.frames[0]!.scope).toBe('workspace');
    expect(plans[0]!.frames[0]!.projectKey).toBeUndefined();
  });
});

// ---- the origin decision --------------------------------------------------------------------------

describe('the origin node still receives its own applied ops via replica — replica.ts is the only place pendingSince clears for ordinary writes (D4)', () => {
  it('a target whose nodeId matches originNodeId is not excluded or special-cased', () => {
    const ops = [makeOp({ entityId: 't1', hubSeq: 1, nodeId: 'node-origin' })];

    const plans = planReplicaFanout({
      scope: 'project',
      applied: ops,
      targets: [target('node-origin', 0), target('node-other', 0)],
      originNodeId: 'node-origin',
    });

    const originPlan = plans.find((p) => p.nodeId === 'node-origin');
    expect(originPlan).toBeDefined();
    expect(originPlan?.frames[0]?.changes).toEqual(ops);

    // The origin is treated exactly like any other target: same watermark rule, same result shape
    // as a node that authored nothing in this batch.
    const otherPlan = plans.find((p) => p.nodeId === 'node-other');
    expect(otherPlan?.frames).toEqual(originPlan?.frames);
  });

  it('the origin is still filtered by ITS OWN watermark like any other target, once it has caught up', () => {
    const ops = [makeOp({ entityId: 't1', hubSeq: 1, nodeId: 'node-origin' })];

    const plans = planReplicaFanout({
      scope: 'project',
      applied: ops,
      targets: [target('node-origin', 1)], // already applied hubSeq 1 itself
      originNodeId: 'node-origin',
    });

    expect(plans).toEqual([]);
  });
});

// ---- negative control -------------------------------------------------------------------------

describe('negative control — an empty plan', () => {
  it('returns [] when no target has anything owed (everyone caught up)', () => {
    const ops = [makeOp({ entityId: 't1', hubSeq: 5 }), makeOp({ entityId: 't2', hubSeq: 9 })];
    const plans = planReplicaFanout({
      scope: 'project',
      applied: ops,
      targets: [target('node-a', 9), target('node-b', 12)],
    });
    expect(plans).toEqual([]);
  });

  it('returns [] when there are no ops applied at all', () => {
    const plans = planReplicaFanout({
      scope: 'project',
      applied: [],
      targets: [target('node-a', 0), target('node-b', 0)],
    });
    expect(plans).toEqual([]);
  });

  it('returns [] when there are no targets at all', () => {
    const plans = planReplicaFanout({
      scope: 'project',
      applied: [makeOp({ entityId: 't1', hubSeq: 1 })],
      targets: [],
    });
    expect(plans).toEqual([]);
  });

  it('never produces a plan entry with an empty frames array — a caught-up target is absent, not present-with-nothing', () => {
    const ops = [makeOp({ entityId: 't1', hubSeq: 5 })];
    const plans = planReplicaFanout({ scope: 'project', applied: ops, targets: [target('node-a', 5)] });
    expect(plans.some((p) => p.frames.length === 0)).toBe(false);
    expect(plans).toEqual([]);
  });
});

// ---- tombstones and content ride through unchanged, per D6/D4 -------------------------------------

describe('op content rides through a replica frame unchanged — this file decides routing, never rewrites content', () => {
  it('a tombstone op is packed exactly like any other op', () => {
    const op = makeOp({ entityId: 't1', hubSeq: 1, op: 'tombstone' });
    const plans = planReplicaFanout({ scope: 'project', applied: [op], targets: [target('node-a', 0)] });
    expect(plans[0]!.frames[0]!.changes).toEqual([op]);
  });
});
