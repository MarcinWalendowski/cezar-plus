import type { ClusterAckFrame, ClusterAckResult, ClusterOp, ClusterOpsFrame } from '@loki-labs/better-cezar-contract';

/**
 * What the hub DOES with an `ops` frame once it arrives — the real thing `hub-router.ts`'s `ops`
 * case will call, in place of today's "warns and returns `[]`" (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "What remains" → Milestone B; D4 · D6 · D7 ·
 * D9a). **Pure orchestration — no I/O, no filesystem, no network.** Everything that touches durable
 * state is injected (`HubOpsDeps`): `hubSeq` allocation (`cluster/hub-seq.ts#HubSeqAllocator`,
 * closed over this frame's `scope`/`projectKey` by the caller) and applying one op to the hub's own
 * store are both sibling packages this file depends on by INTERFACE only, never by construction —
 * so this module is testable with fakes and stays correct regardless of which package lands first.
 *
 * **Never fabricate an ack for something not applied.** This is the existing house rule
 * `hub-router.ts`'s `ops` case already states for why it stubs rather than answers; this file is
 * that answer, and every design choice below exists to keep the rule true under partial failure,
 * not just the happy path.
 *
 * ---
 *
 * ### `throughHubSeq` — what it may legally claim, and why
 *
 * The contract's own doc on `clusterAckFrameSchema.throughHubSeq` is the whole spec: "everything at
 * or below this is durably applied at the hub and may be dropped from the outbox." That is a
 * WATERMARK, not a per-op list — a spoke is free to use it alone, without cross-referencing
 * `results` by `opId`, to decide what it may stop resending. So it must never claim more than is
 * true, or a spoke drops a write it never actually landed and loses it permanently — the exact
 * failure this module exists to prevent.
 *
 * `hubSeq` is allocated in FRAME order as one contiguous reservation (requirement below), so the
 * ops in one frame occupy a contiguous run of numbers. If every op in that run reaches a definite
 * verdict, the watermark can legally cover the whole run. If one does NOT — `applyOp` threw, rather
 * than returning a verdict — the watermark must stop at the last CONTIGUOUS resolved op from the
 * START of the frame, even if later ops in the same frame individually succeeded. Two things follow
 * from "at or below", not "each individually":
 *
 *  - A op after the gap that itself succeeded still gets its own `results` entry (`accepted: true`),
 *    so a spoke that DOES cross-reference by `opId` need not resend it. But `throughHubSeq` cannot
 *    be advanced past the gap to cover it, because the watermark alone cannot express a hole — a
 *    spoke that trusts the watermark alone would then believe the failed op (sitting BELOW that
 *    later success's `hubSeq`) was also durably applied, and drop it. That is the silent data loss
 *    this docblock exists to name.
 *  - The failed op itself never appears in `results` at all (see "a REJECTED op vs. a THROWN one"
 *    below) — an entry with a fabricated verdict would be exactly the fabrication the house rule
 *    forbids, and its `hubSeq` was still consumed (burned, never reused: allocation happens before
 *    any op is applied, so a failure after allocation cannot un-allocate it). A gap in the sequence
 *    is normal and expected, the same as a rolled-back autoincrement row.
 *
 * ### A REJECTED op vs. a THROWN one — the distinction the whole module rests on
 *
 * These look similar (`applyOp` did not accept the op) and are treated as OPPOSITES:
 *
 *  - **Rejected** (`applyOp` RETURNS `{ accepted: false, reason, fields? }`) is a considered,
 *    durable verdict — the hub examined the op and decided, in this state, not to apply it (D9a's
 *    own example: another node already won the claim). That decision will not change if the same op
 *    is retried, because retrying does not change the state that produced it. It is therefore
 *    treated exactly like an accepted op for `throughHubSeq`: fully resolved, safe to drop from the
 *    outbox, and any correction rides in `fields` — this is precisely what makes D9a's "confirm
 *    before start" implementable (`todos.ts#markStartedWithClaim` already consumes an
 *    `accepted: false` result as terminal, writing the winner's `startedOn` and never retrying).
 *  - **Thrown** (`applyOp` THROWS) means the hub never reached a verdict at all — a transient
 *    failure (a write error, a lock timeout, a bug), not a business decision. Converting this into a
 *    synthetic `{ accepted: false }` would fabricate a permanent verdict for a temporary failure:
 *    the spoke would treat it exactly like a real rejection (per the paragraph above) and drop a
 *    write that was never applied. So a thrown op gets NO `results` entry, is never passed to
 *    `recordAppliedOp`, and creates a gap in `throughHubSeq` — the spoke's outbox keeps the record
 *    pending and resends it on the next flush, which is the whole point of D5's "the outbox is
 *    re-derived, so a lost tail loses nothing" reasoning applied one layer up.
 *
 * ### Idempotence — a retransmit must reproduce the SAME verdict, not a new one
 *
 * The contract's own doc says a dropped frame "costs a retransmit and never a gap" — so the SAME
 * frame (byte-identical `ops`, same `opId`s) can arrive twice: once, silently lost in transit on the
 * way back as an `ack`, and again when the spoke's outbox retries after the timeout. Re-running
 * `allocateSeq` and `applyOp` for an already-resolved `opId` is wrong on both counts named in the
 * brief: it burns a second `hubSeq` for the same op (breaking "allocate once, in frame order"), and
 * for a D9a claim op specifically, re-applying it a SECOND time would see the FIRST application's
 * own effect already in place and report a false conflict — "someone else already claimed this",
 * where the someone is itself.
 *
 * So every op is checked against `deps.findAppliedOp(opId)` BEFORE any allocation happens, in frame
 * order. A hit is used verbatim (same `hubSeq`, same verdict, same `fields`) and contributes no
 * count to the `allocateSeq` reservation; only genuinely new ops (a cache miss) get a slice of the
 * ONE reservation covering just them. `findAppliedOp`/`recordAppliedOp` must be backed by durable
 * storage, not an in-memory `Map` — the hub blue-green deploys roughly ten times a day (the same
 * reason `hubSeq` itself has to survive a restart), so an in-process cache would silently stop
 * working on every deploy and this module would go back to double-applying across restarts, which
 * is exactly the failure this paragraph exists to close.
 *
 * A limitation worth stating rather than silently accepting: the wire schema does not forbid two
 * ops in the SAME frame sharing one `opId`. Because every op's cache lookup happens up front, before
 * any of this frame's own writes land, two same-`opId` entries in one frame are both read as cache
 * misses and both get applied — the second `recordAppliedOp` call overwrites the first's stored
 * verdict, and the returned `results` carries two entries for one `opId`, with two different
 * `hubSeq`s. This is a same-frame duplicate, not a cross-frame replay, and is out of scope for the
 * idempotence guarantee above, which is specifically about the SAME frame arriving more than once.
 */

export interface HubOpAllocation {
  readonly from: number;
  readonly to: number;
}

/** What applying one op to the hub's own store produced. `fields` is populated only when the hub's
 *  applied result differs from what the op proposed (the contract's own doc on
 *  `clusterAckResultSchema.fields`) — e.g. a D9a claim loss carries the winner's `startedOn`. */
export interface HubOpOutcome {
  readonly accepted: boolean;
  readonly fields?: Record<string, unknown>;
  readonly reason?: string;
}

export interface HubOpsDeps {
  /** Reserves a contiguous run of `count` hub-order numbers, returning the first and last
   *  (inclusive). `count: 0` is the "tell me the current watermark without reserving anything"
   *  query — the real implementation (`cluster/hub-seq.ts#HubSeqAllocator`) answers it with
   *  `{ from: base + 1, to: base }`, i.e. `to` alone names the current watermark and `to < from`
   *  signals nothing was reserved. Injected — construct the real one from a sibling package,
   *  closed over this frame's `scope`/`projectKey`, never here. */
  readonly allocateSeq: (count: number) => Promise<HubOpAllocation>;
  /** Applies one op — already stamped with the `hubSeq` this module allocated for it — to the hub's
   *  own store, and reports what actually happened. Injected, for the same reason as `allocateSeq`. */
  readonly applyOp: (op: ClusterOp & { hubSeq: number }) => Promise<HubOpOutcome>;
  /** The durable verdict already on file for this `opId`, if the hub has resolved it before —
   *  possibly in an earlier process (see the module docblock's "Idempotence" section). `undefined`
   *  means genuinely new. */
  readonly findAppliedOp: (opId: string) => Promise<ClusterAckResult | undefined>;
  /** Persists the verdict for `opId` durably, so a later replay of the same frame answers from here
   *  instead of re-applying. Called for every resolved op (accepted OR rejected), never for one that
   *  threw — see "A REJECTED op vs. a THROWN one" above. */
  readonly recordAppliedOp: (opId: string, result: ClusterAckResult) => Promise<void>;
  readonly warn?: (message: string) => void;
}

function toAckResult(op: ClusterOp, hubSeq: number, outcome: HubOpOutcome): ClusterAckResult {
  return {
    opId: op.opId,
    hubSeq,
    accepted: outcome.accepted,
    ...(outcome.fields !== undefined ? { fields: outcome.fields } : {}),
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
  };
}

/**
 * Applies every op in an uplink `ops` frame and builds the `ack` to send back. See the module
 * docblock for the `throughHubSeq` reasoning, the rejected-vs-thrown distinction, and the
 * idempotence guarantee — this function is the mechanical implementation of all three.
 */
export async function applyOpsFrame(frame: ClusterOpsFrame, deps: HubOpsDeps): Promise<ClusterAckFrame> {
  const base: Omit<ClusterAckFrame, 'throughHubSeq' | 'results'> = {
    type: 'ack',
    protocol: frame.protocol,
    scope: frame.scope,
    ...(frame.projectKey !== undefined ? { projectKey: frame.projectKey } : {}),
  };

  if (frame.ops.length === 0) {
    // Nothing to check for a replay and nothing to allocate a range for — but the caller still
    // needs a `throughHubSeq` to report, so `allocateSeq(0)` is used purely as a "what is the
    // current watermark" query (see `HubOpsDeps#allocateSeq`'s own docblock for the `to < from`,
    // no-op convention this relies on).
    const empty = await deps.allocateSeq(0);
    return { ...base, throughHubSeq: empty.to, results: [] };
  }

  // 1. Idempotence check, per op, IN FRAME ORDER, before any allocation — see "Idempotence" above.
  const cached: (ClusterAckResult | undefined)[] = [];
  for (const op of frame.ops) {
    cached.push(await deps.findAppliedOp(op.opId));
  }

  const freshIndices: number[] = [];
  for (let i = 0; i < frame.ops.length; i++) {
    if (cached[i] === undefined) freshIndices.push(i);
  }

  // 2. ONE reservation covering every genuinely new op in this frame — never one call per op
  //    (requirement: "the allocation is the hub's ordering decision"). Skipped entirely when the
  //    whole frame is a replay, so a fully-cached retransmit costs no counter movement at all.
  const alloc = freshIndices.length > 0 ? await deps.allocateSeq(freshIndices.length) : undefined;

  // 3. Apply each fresh op, in frame order, stamped with its slice of the reservation. One op
  //    throwing is caught here and turned into a gap (see "A REJECTED op vs. a THROWN one"), never
  //    an exception that escapes and takes the rest of the frame down with it.
  const resolved: (ClusterAckResult | undefined)[] = cached.slice();
  for (const [k, idx] of freshIndices.entries()) {
    const op = frame.ops[idx]!;
    const hubSeq = alloc!.from + k;
    try {
      const outcome = await deps.applyOp({ ...op, hubSeq });
      const result = toAckResult(op, hubSeq, outcome);
      await deps.recordAppliedOp(op.opId, result);
      resolved[idx] = result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.warn?.(
        `cluster hub: op ${op.opId} (${op.entity}/${op.entityId}) threw while applying at hubSeq ${hubSeq} — ` +
          `left unacknowledged; the spoke keeps it in its outbox and retries it (${message})`,
      );
      // resolved[idx] stays undefined: a gap. Never recorded, never counted toward throughHubSeq.
    }
  }

  // 4. Walk the frame in order. `results` gets every resolved op — cached or freshly applied,
  //    accepted or rejected alike (both are final verdicts, see the module docblock). `throughHubSeq`
  //    only advances through the CONTIGUOUS resolved prefix, stopping dead at the first gap, so it
  //    never claims more than "durably applied" is actually true for.
  const results: ClusterAckResult[] = [];
  // Only reachable in output when op[0] itself is fresh and throws — a cached op can never be the
  // first gap, so whenever this fallback could leak into the return, `alloc` is guaranteed defined.
  let throughHubSeq = alloc ? alloc.from - 1 : 0;
  let gapSeen = false;
  for (let i = 0; i < frame.ops.length; i++) {
    const result = resolved[i];
    if (result === undefined) {
      gapSeen = true;
      continue;
    }
    results.push(result);
    if (!gapSeen) throughHubSeq = result.hubSeq;
  }

  return { ...base, throughHubSeq, results };
}
