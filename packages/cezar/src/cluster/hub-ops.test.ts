import { describe, expect, it } from 'vitest';
import { CLUSTER_PROTOCOL, type ClusterAckResult, type ClusterOp, type ClusterOpsFrame } from '@loki-labs/better-cezar-contract';
import { applyOpsFrame, type HubOpAllocation, type HubOpOutcome, type HubOpsDeps } from './hub-ops.ts';

/**
 * Package B (`cluster/hub-ops.ts`) — what the hub DOES with an `ops` frame, per
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`'s "What remains" → Milestone B table row
 * "hub applies an ops frame: `hub-router.ts` `ops` case — warns and returns `[]`". This file is
 * the real thing behind that stub. Every dependency (`hub-seq.ts`'s allocator, applying an op to
 * the hub's own store, the durable idempotence cache) is a FAKE here, in-memory but never an
 * in-process `Map` masquerading as durable state without being named as a fake — see each helper's
 * own comment for what it stands in for.
 */

function makeOp(overrides: Partial<ClusterOp> = {}): ClusterOp {
  return {
    opId: 'op-1',
    nodeId: 'node-a',
    ts: '2026-08-23T00:00:00.000Z',
    scope: 'project',
    projectKey: 'proj-1',
    entity: 'todo',
    entityId: 'todo-1',
    op: 'upsert',
    fields: { status: 'done' },
    ...overrides,
  };
}

function makeFrame(ops: ClusterOp[]): ClusterOpsFrame {
  return {
    type: 'ops',
    protocol: CLUSTER_PROTOCOL,
    scope: 'project',
    projectKey: 'proj-1',
    ops,
  };
}

interface FakeHub {
  deps: HubOpsDeps;
  /** Every `applyOp` call, in the order it happened — `applyOp` calls only, never `findAppliedOp`
   *  hits, so this is the right thing to assert "did NOT re-apply" against. */
  applyCalls: (ClusterOp & { hubSeq: number })[];
  /** Every `allocateSeq(count)` argument, in call order. */
  allocateCalls: number[];
  warnings: string[];
  /** The durable idempotence store `findAppliedOp`/`recordAppliedOp` read and write — exposed so a
   *  test can assert on it directly, standing in for whatever storage the real sibling package
   *  uses (must survive the hub's own restarts, per the module's docblock; this fake does not need
   *  to, since a test process never restarts mid-test). */
  appliedStore: Map<string, ClusterAckResult>;
}

/** `applyOutcomes` maps `opId` to either a `HubOpOutcome` to return, or an `Error` to throw —
 *  the two paths the module docblock treats as opposites (a returned verdict vs. a thrown one).
 *  Unlisted ops accept unconditionally. `allocateSeq` reserves a genuinely contiguous, ever-growing
 *  range starting at 1, mirroring `HubSeqAllocator#allocate`'s `{ from: base + 1, to: base + count }`
 *  contract (including its `count: 0` → `{ from: base + 1, to: base }` no-op convention). */
function makeFakeHub(applyOutcomes: Record<string, HubOpOutcome | Error> = {}): FakeHub {
  let base = 0;
  const appliedStore = new Map<string, ClusterAckResult>();
  const applyCalls: (ClusterOp & { hubSeq: number })[] = [];
  const allocateCalls: number[] = [];
  const warnings: string[] = [];

  const allocateSeq = async (count: number): Promise<HubOpAllocation> => {
    allocateCalls.push(count);
    if (count === 0) return { from: base + 1, to: base };
    const from = base + 1;
    base += count;
    return { from, to: base };
  };

  const applyOp = async (op: ClusterOp & { hubSeq: number }): Promise<HubOpOutcome> => {
    applyCalls.push(op);
    const outcome = applyOutcomes[op.opId];
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { accepted: true };
  };

  const findAppliedOp = async (opId: string) => appliedStore.get(opId);
  const recordAppliedOp = async (opId: string, result: ClusterAckResult) => {
    appliedStore.set(opId, result);
  };

  const warn = (message: string) => {
    warnings.push(message);
  };

  return {
    deps: { allocateSeq, applyOp, findAppliedOp, recordAppliedOp, warn },
    applyCalls,
    allocateCalls,
    warnings,
    appliedStore,
  };
}

describe('cluster/hub-ops applyOpsFrame', () => {
  it('round trip: N ops become an ack with results lined up by opId and strictly increasing hubSeq', async () => {
    const hub = makeFakeHub();
    const frame = makeFrame([
      makeOp({ opId: 'op-1', entityId: 'todo-1' }),
      makeOp({ opId: 'op-2', entityId: 'todo-2' }),
      makeOp({ opId: 'op-3', entityId: 'todo-3' }),
    ]);

    const ack = await applyOpsFrame(frame, hub.deps);

    expect(ack.type).toBe('ack');
    expect(ack.protocol).toBe(CLUSTER_PROTOCOL);
    expect(ack.scope).toBe('project');
    expect(ack.projectKey).toBe('proj-1');
    expect(ack.results?.map((r) => r.opId)).toEqual(['op-1', 'op-2', 'op-3']);
    expect(ack.results?.every((r) => r.accepted)).toBe(true);
    const seqs = ack.results!.map((r) => r.hubSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
    expect(ack.throughHubSeq).toBe(seqs[2]);
    // One reservation for the whole frame, not one call per op.
    expect(hub.allocateCalls).toEqual([3]);
    expect(hub.applyCalls).toHaveLength(3);
  });

  it('partial failure (business rejection): a rejected middle op is resolved, not a gap — throughHubSeq covers the whole frame', async () => {
    const hub = makeFakeHub({
      'op-3': { accepted: false, reason: 'validation failed' },
    });
    const frame = makeFrame([
      makeOp({ opId: 'op-1', entityId: 'todo-1' }),
      makeOp({ opId: 'op-2', entityId: 'todo-2' }),
      makeOp({ opId: 'op-3', entityId: 'todo-3' }),
      makeOp({ opId: 'op-4', entityId: 'todo-4' }),
      makeOp({ opId: 'op-5', entityId: 'todo-5' }),
    ]);

    const ack = await applyOpsFrame(frame, hub.deps);

    expect(ack.results?.map((r) => r.opId)).toEqual(['op-1', 'op-2', 'op-3', 'op-4', 'op-5']);
    const rejected = ack.results!.find((r) => r.opId === 'op-3')!;
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toBe('validation failed');
    // A REJECTION is a durable, considered verdict (see module docblock) — the other four still
    // applied, and the watermark is legally allowed to cover the whole contiguous run.
    const maxSeq = Math.max(...ack.results!.map((r) => r.hubSeq));
    expect(ack.throughHubSeq).toBe(maxSeq);
    expect(hub.applyCalls).toHaveLength(5);
  });

  it('partial failure (thrown exception): a gap stops throughHubSeq before it, but ops after it still get their own accepted result', async () => {
    const hub = makeFakeHub({
      'op-3': new Error('hub store write failed'),
    });
    const frame = makeFrame([
      makeOp({ opId: 'op-1', entityId: 'todo-1' }),
      makeOp({ opId: 'op-2', entityId: 'todo-2' }),
      makeOp({ opId: 'op-3', entityId: 'todo-3' }),
      makeOp({ opId: 'op-4', entityId: 'todo-4' }),
      makeOp({ opId: 'op-5', entityId: 'todo-5' }),
    ]);

    const ack = await applyOpsFrame(frame, hub.deps);

    // One bad op does not lose the other four: all applyOp calls happened.
    expect(hub.applyCalls).toHaveLength(5);
    // op-3 never reached a verdict — no fabricated result for it.
    const opIds = ack.results!.map((r) => r.opId);
    expect(opIds).not.toContain('op-3');
    expect(opIds).toEqual(['op-1', 'op-2', 'op-4', 'op-5']);
    expect(ack.results!.find((r) => r.opId === 'op-4')!.accepted).toBe(true);
    expect(ack.results!.find((r) => r.opId === 'op-5')!.accepted).toBe(true);

    // throughHubSeq must NOT cover op-3's hubSeq or anything above it, even though op-4/op-5
    // (which sit at HIGHER hubSeqs than op-3) individually succeeded — the watermark cannot
    // express the hole, so it stops at op-2's hubSeq.
    const seqByOpId = new Map(ack.results!.map((r) => [r.opId, r.hubSeq]));
    expect(ack.throughHubSeq).toBe(seqByOpId.get('op-2'));
    expect(ack.throughHubSeq).toBeLessThan(seqByOpId.get('op-4')!);

    // op-3 was never recorded as resolved — a later replay must retry it, not skip it.
    expect(hub.appliedStore.has('op-3')).toBe(false);
    expect(hub.warnings.some((w) => w.includes('op-3'))).toBe(true);
  });

  it('a thrown op is retried on the next delivery, not permanently rejected', async () => {
    const failingHub = makeFakeHub({ 'op-1': new Error('transient') });
    const frame = makeFrame([makeOp({ opId: 'op-1' })]);

    const firstAck = await applyOpsFrame(frame, failingHub.deps);
    expect(firstAck.results).toEqual([]);
    expect(failingHub.appliedStore.has('op-1')).toBe(false);

    // Simulate the spoke resending the same op after seeing no result for it. Build a hub that
    // shares the SAME durable idempotence store but now succeeds — a permanently-cached rejection
    // would prevent this second attempt from ever calling applyOp again.
    const secondAttemptOutcomes: Record<string, HubOpOutcome | Error> = {};
    const secondHub = makeFakeHub(secondAttemptOutcomes);
    // Reuse the first hub's store to prove nothing was recorded for op-1 by the failed attempt.
    (secondHub.deps as { findAppliedOp: HubOpsDeps['findAppliedOp'] }).findAppliedOp = failingHub.deps.findAppliedOp;
    (secondHub.deps as { recordAppliedOp: HubOpsDeps['recordAppliedOp'] }).recordAppliedOp = failingHub.deps.recordAppliedOp;

    const secondAck = await applyOpsFrame(frame, secondHub.deps);
    expect(secondHub.applyCalls).toHaveLength(1);
    expect(secondAck.results?.[0]?.opId).toBe('op-1');
    expect(secondAck.results?.[0]?.accepted).toBe(true);
  });

  it('replay: the identical frame delivered twice is answered from cache — same verdict, same hubSeq, no second allocation', async () => {
    const hub = makeFakeHub();
    const frame = makeFrame([makeOp({ opId: 'op-1' }), makeOp({ opId: 'op-2' })]);

    const firstAck = await applyOpsFrame(frame, hub.deps);
    expect(hub.allocateCalls).toEqual([2]);
    expect(hub.applyCalls).toHaveLength(2);

    const secondAck = await applyOpsFrame(frame, hub.deps);

    // No new reservation, no re-application — every op in the replay was a cache hit.
    expect(hub.allocateCalls).toEqual([2]);
    expect(hub.applyCalls).toHaveLength(2);
    expect(secondAck).toEqual(firstAck);
  });

  it('replay after a rejection is idempotent too: a claim-loss verdict replays identically, never re-evaluated', async () => {
    const hub = makeFakeHub({
      'claim-op': { accepted: false, reason: 'another node holds this claim', fields: { startedOn: 'node-b' } },
    });
    const frame = makeFrame([makeOp({ opId: 'claim-op', entityId: 'todo-1' })]);

    const firstAck = await applyOpsFrame(frame, hub.deps);
    expect(firstAck.results?.[0]).toMatchObject({ accepted: false, reason: 'another node holds this claim' });
    expect(hub.applyCalls).toHaveLength(1);

    const secondAck = await applyOpsFrame(frame, hub.deps);

    expect(hub.applyCalls).toHaveLength(1); // not called again
    expect(hub.allocateCalls).toEqual([1]); // no second reservation
    expect(secondAck).toEqual(firstAck);
  });

  it('D9a claim loss: another node already won → accepted:false AND fields carries the winner', async () => {
    const hub = makeFakeHub({
      'claim-op': {
        accepted: false,
        reason: 'another node holds this claim',
        fields: { startedOn: 'node-b', startedTaskId: 'task-42' },
      },
    });
    const frame = makeFrame([makeOp({ opId: 'claim-op', entityId: 'todo-1' })]);

    const ack = await applyOpsFrame(frame, hub.deps);

    const result = ack.results![0]!;
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('another node holds this claim');
    expect(result.fields).toEqual({ startedOn: 'node-b', startedTaskId: 'task-42' });
  });

  it('empty ops frame: throughHubSeq reflects the current watermark via allocateSeq(0), nothing applied', async () => {
    const hub = makeFakeHub();
    // Move the watermark forward first so the empty-frame answer is not trivially 0.
    await applyOpsFrame(makeFrame([makeOp({ opId: 'op-1' })]), hub.deps);

    const ack = await applyOpsFrame(makeFrame([]), hub.deps);

    expect(ack.results).toEqual([]);
    expect(ack.throughHubSeq).toBe(1);
    expect(hub.applyCalls).toHaveLength(1); // unchanged — the empty frame applied nothing
    expect(hub.allocateCalls).toEqual([1, 0]);
  });
});
