import {
  type ClusterNodeId,
  type ClusterOp,
  type ClusterProjectKey,
  type ClusterReplicaFrame,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { readTodos as readTodosDefault, type TodoItem } from '../todos.ts';
import { applyOpAtHub } from './hub-apply.ts';
import type { HubOpOutcome } from './hub-ops.ts';
import type { HubSeqAllocator } from './hub-seq.ts';
import { DEFAULT_OP_SEND_BUDGET, deriveTodoOps, packOpsFrame, type OpSendBudget } from './ops.ts';
import { planReplicaFanout } from './replica-fanout.ts';

/**
 * The HUB's own write outbox (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D37).
 *
 * **The defect this closes, measured on production 2026-08-24.** `cluster/ops.ts#deriveTodoOps` has
 * exactly one production caller, `spoke-runtime.ts` — so a todo written directly on the hub
 * (`prod-host`, where the owner's own agents run) stamps `pendingSince` and then NOTHING ever
 * derives, allocates, applies or fans out an op for it. Measured: all 159 hub-local todos carry
 * `hubSeq: null`; only 2 of 159 carry `pendingSince`; a paired spoke's `todos.json` does not exist
 * because nothing has ever replicated down; dispatch to that spoke fails with "todo … is not present
 * locally" because `clusterDispatchFrameSchema` carries `todoId` only, never content, and assumes the
 * record already reached the target by ordinary replication. This file is the missing half: the
 * mirror image of `spoke-runtime.ts`'s outbox flush, run on the hub instead of a spoke, reusing the
 * SAME machinery a spoke's `ops` frame goes through once it reaches the hub — `ops.ts#deriveTodoOps`,
 * `hub-seq.ts#createHubSeqAllocator`, `hub-apply.ts#applyOpAtHub`, `replica-fanout.ts#planReplicaFanout`
 * — rather than a parallel copy of any of them.
 *
 * **Why a hub-local write can be applied SYNCHRONOUSLY, with no round trip.** A spoke's `ops` frame
 * has to travel to the hub, get a `hubSeq`, and come back as an `ack`/`replica` before the spoke's own
 * `pendingSince` can clear (`applyOpToRecord` in `cluster/replica.ts`, driven only by a `replica`
 * frame's `changes`). The hub has no such asymmetry: it IS the authority `hub-apply.ts#applyOpAtHub`
 * decides against, so one tick can derive an op, allocate its `hubSeq`, and apply it to the hub's own
 * `todos.json` in the same breath — no ack, no separate settlement path, no D35-shaped gap.
 *
 * **The two populations this outbox must pick up, and why the selection key is NOT `pendingSince`.**
 *
 *  1. **Steady state.** An ordinary hub-local write goes through `todos.ts#stampPending`, which sets
 *     `pendingSince`/`pendingFields` exactly like a spoke's own write does. `deriveTodoOps` already
 *     knows how to read this population — no enrichment needed.
 *  2. **The backfill.** `stampPending` opens `if (!clusteringOn(options)) return;` — a write from a
 *     process with clustering off stamps NO marker at all. `cez todo add` run over ssh on the hub does
 *     not inherit `CEZ_CLUSTER=1` (it lives in the systemd unit, not `/etc/profile.d/`), so every todo
 *     filed that way is born with **neither** `pendingSince` nor `hubSeq`. That is how 157 of the
 *     hub's 159 todos ended up outside `deriveTodoOps`'s own gate (`if (!todo.pendingSince) continue`)
 *     — a gate this file must not lean on alone, or it replicates the 2 records that happen to carry
 *     the marker and silently strands the other 157 forever (the bug reproduced, not fixed).
 *
 * So `selectOwed` below keys on **`Boolean(todo.pendingSince) || todo.hubSeq === undefined`** — the
 * union of "genuinely pending" (population 1, and an EDIT to an already-replicated record, which
 * still carries a `hubSeq` from its first sync) and "never yet replicated" (population 2, and any
 * still-mid-flight population-1 record for which `hubSeq === undefined` is simply also true). A fully
 * settled record (`hubSeq` set, `pendingSince` absent) satisfies neither half and is correctly left
 * alone — this is what makes a second tick over the same state send nothing.
 *
 * **Feeding the backfill population through `deriveTodoOps` unchanged.** `deriveTodoOps`'s own primary
 * gate is `if (!todo.pendingSince) continue`, so a population-2 record — selected above precisely
 * because it lacks that field — would be silently skipped by the very function meant to derive its
 * op. Rather than writing a second, parallel op-deriver (the one thing this file must not do), a
 * selected record with no `pendingSince` is handed to `deriveTodoOps` as an in-memory copy carrying a
 * synthetic `pendingSince` set to "now" — never written back to disk; the record's real state is
 * decided once, durably, by `applyOpAtHub`'s own write below. This is an honest characterization, not
 * a workaround dressed up as one: the record genuinely IS owed to the hub's own replication order as
 * of this tick, which is exactly what `pendingSince` means. A record whose `pendingSince` is already
 * set is passed through untouched. `pendingFields` is deliberately left alone in both cases:
 * `deriveTodoOps`'s own "missing `pendingFields`" fallback (send the whole record) is precisely
 * correct for a record that has never been replicated at all, and for an ordinary edit `stampPending`
 * has already set it correctly.
 *
 * **`ackedThroughHubSeq: 0`, always, and this is not a placeholder.** `deriveTodoOps`'s defensive
 * second gate (skip a record whose OWN `hubSeq` already covers what the hub has acked) exists for a
 * SPOKE, which needs to know what a DIFFERENT process — the hub — has confirmed. On the hub, "the hub
 * has confirmed it" and "this record's `hubSeq` is set" are the same fact, already fully captured by
 * `selectOwed`'s primary filter and by `pendingSince` genuinely clearing on a successful apply (see
 * below) — there is no second, asynchronous confirmation for a fixed constant to stand in for. Passing
 * anything other than `0` here would not change what this file selects; `0` is simply the honest
 * value for "nothing here is waiting on an acknowledgement from itself."
 *
 * **Idempotent and crash-safe by construction, not by a history store.** A tick that dies between
 * allocating a `hubSeq` and applying it burns that number (an accepted, standing cost elsewhere in
 * this design — see `hub-ops.ts`'s own "retransmit burns a second `hubSeq`" note) and simply re-derives
 * a fresh op with a fresh `opId` next tick; `applyOpAtHub`'s own monotonicity guard
 * (`op.hubSeq <= existing.hubSeq` → accepted, no-op) makes a duplicate re-application of an
 * already-applied record harmless even if two ticks somehow overlapped. No `op-history.ts`-style
 * dedupe cache is needed here the way `hub-ops.ts` needs one for a SPOKE's retransmit: a hub-local
 * derive never travels over a wire and back, so there is nothing to replay.
 *
 * **The per-tick apply cap reuses the wire's own budget, not a new number.** `packOpsFrame` (the
 * spoke's own outbound bin-packer) is called on the derived batch purely for its op-count/byte-size
 * splitting — `CLUSTER_OPS_PER_FRAME_MAX` / `CLUSTER_FRAME_MAX_BYTES`, the contract's bounds, not an
 * invented one — and only `.sent`/`.remaining` are used; the `.frame` it also builds is discarded,
 * because nothing here sends an `ops` frame anywhere. `.remaining` is not queued: it stays
 * `pendingSince`/`hubSeq: undefined` on disk and `selectOwed` picks it up again next tick, the same
 * "derive fresh from records, never hold a queue" posture `spoke-runtime.ts#flushProject` documents
 * for its own remainder.
 *
 * **Fan-out reuses `planReplicaFanout` exactly as `hub-router.ts`'s `ops` case does** — only ops this
 * tick actually got `{ accepted: true }` from `applyOpAtHub` are fanned out (a rejected op was never
 * written to the hub's store, so replicating it would push a value the hub itself refused); every
 * `excluded` entry `planReplicaFanout` reports is warned exactly once. Delivery accessors
 * (`connectedNodes`/`readWatermark`/`advanceWatermark`/`sendTo`) are injected rather than owned here:
 * only the caller holding `hub-router.ts`'s in-memory watermark map and `ClusterLinkServer` can supply
 * real ones, and this file must draw from the SAME watermark state that map already tracks for the
 * spoke-originated `ops` path — a second, independent watermark store here would let the two fan-out
 * paths disagree about what a target has already applied.
 *
 * **Two residual gaps, named rather than papered over, both already accepted elsewhere in this
 * design for the symmetric spoke-originated case:**
 *
 *  - **A rejected hub-local claim never settles.** `applyOpAtHub` writes nothing to disk on a D9a
 *    claim loss, so a hub-local record whose claim lost stays `pendingSince` and is re-derived (with a
 *    fresh `opId`, burning a fresh `hubSeq`) every tick forever — the same class of leak D35 names for
 *    a spoke's own outbox, whose fix (connect-time replay settling a refusal) is not built anywhere
 *    yet and is not this file's job to build.
 *  - **A fan-out send failure is retried only by a LATER batch, not by this same tick replaying
 *    itself.** Once an op is applied, `hubSeq` is set and `selectOwed` will never select that record
 *    again — so if `sendTo` fails for a target, that target's watermark is correctly left unadvanced
 *    (the record is still owed to it, and durably safe at the hub), but nothing here re-offers that
 *    specific op to that target until some OTHER hub-local write produces a new batch for the same
 *    project, or until a full state-scan connect-time replay (spec's "Design B", not built) closes the
 *    gap for a target that reconnects with nothing new flowing. This is the identical characteristic
 *    `hub-router.ts`'s own `ops` case already has for a spoke-originated batch ("left owed, it will be
 *    re-sent on the next batch or replayed from its next `hello`") — not a new, lower bar introduced
 *    here.
 */

const DEFAULT_HUB_OUTBOX_INTERVAL_MS = 5_000;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One project the hub itself hosts todos for — its `projectKey` (D2) and the `.ai/cezar` dir
 *  `todos.ts` reads/writes for it. Mirrors `spoke-runtime.ts#SpokeOutboxProject`'s shape; there is no
 *  pairing concept on the hub side, so this carries no `repoRoot`. */
export interface HubOutboxProject {
  projectKey: ClusterProjectKey;
  dataDir: string;
}

/** Delivery accessors this file draws from rather than owns — see module docblock. All four are
 *  semantically scoped to `project` (todos are always project-scoped, D2), so none takes a `scope`
 *  parameter; a caller adapting `hub-router.ts`'s own `(nodeId, key: string)` shape need only close
 *  over `watermarkKey('project', projectKey)` once per call. */
export interface HubOutboxLinkDeps {
  /** Nodes currently eligible to receive a push. The caller decides eligibility (e.g. excluding a
   *  node whose connect-time replay is in flight) — this file treats every returned id as a target. */
  connectedNodes: () => readonly ClusterNodeId[];
  /** What `nodeId` has already applied for `projectKey`. `0` when unknown. */
  readWatermark: (nodeId: ClusterNodeId, projectKey: ClusterProjectKey) => number;
  /** Records that `nodeId` has now applied through `hubSeq` for `projectKey` — called ONLY after a
   *  confirmed `sendTo`. */
  advanceWatermark: (nodeId: ClusterNodeId, projectKey: ClusterProjectKey, hubSeq: number) => void;
  /** Pushes one frame to a connected node; returns whether the write was accepted. */
  sendTo: (nodeId: ClusterNodeId, frame: ClusterReplicaFrame) => boolean;
}

export interface HubOutboxTickDeps extends HubOutboxLinkDeps {
  /** This hub's own node id — becomes `ClusterOp.nodeId` (author) on every op this file derives, and
   *  is passed to `planReplicaFanout` as `originNodeId`. */
  nodeId: ClusterNodeId;
  /** This hub's own projects to flush todos for, read fresh every tick (a project registered or
   *  unregistered between ticks is picked up / dropped without a restart). */
  listProjects: () => Promise<readonly HubOutboxProject[]> | readonly HubOutboxProject[];
  /** Reserves a contiguous `hubSeq` range — pass the SAME `HubSeqAllocator['allocate']` instance the
   *  incoming spoke-`ops` path uses (`hub-seq.ts#createHubSeqAllocator`), so both draw from one
   *  monotonic counter per `(scope, projectKey)`. */
  allocateSeq: HubSeqAllocator['allocate'];
  /** Test hook; defaults to `todos.ts#readTodos` (D5a: healed, never a raw parse). */
  readTodos?: (dataDir: string) => Promise<TodoItem[]>;
  /** Test hook; defaults to `hub-apply.ts#applyOpAtHub`. */
  applyOp?: (dataDir: string, op: ClusterOp & { hubSeq: number }) => Promise<HubOpOutcome>;
  /** Test hook; defaults to `ops.ts#DEFAULT_OP_SEND_BUDGET`. */
  opSendBudget?: OpSendBudget;
  now?: () => Date;
  warn?: (message: string) => void;
}

export interface HubOutboxTickReport {
  projectsProcessed: number;
  /** Ops `applyOpAtHub` accepted and durably wrote this tick. */
  opsApplied: number;
  /** Ops `applyOpAtHub` considered and refused (D9a claim loss, etc.) — durable, no write. See
   *  module docblock's first residual gap. */
  opsRejected: number;
  /** Ops whose apply THREW — transient; left unapplied, re-derived next tick. */
  opsFailed: number;
  /** Owed ops this tick's per-project `packOpsFrame` budget deferred to a later tick. */
  opsDeferred: number;
  /** `ClusterReplicaFrame`s successfully delivered via `sendTo`. */
  framesSent: number;
  /** Distinct nodes that received at least one frame this tick. */
  targetsReached: number;
  /** `planReplicaFanout`'s own `excluded` count — an op too large to fit any frame for some target;
   *  durably applied at the hub regardless (see `replica-fanout.ts`'s own docblock). */
  excluded: number;
}

function emptyReport(): HubOutboxTickReport {
  return {
    projectsProcessed: 0,
    opsApplied: 0,
    opsRejected: 0,
    opsFailed: 0,
    opsDeferred: 0,
    framesSent: 0,
    targetsReached: 0,
    excluded: 0,
  };
}

/** See module docblock, "The two populations" — the union that is neither `pendingSince` alone nor
 *  `hubSeq === undefined` alone. */
function isOwed(todo: TodoItem): boolean {
  return Boolean(todo.pendingSince) || todo.hubSeq === undefined;
}

/** One project's share of one tick — never holds anything past this call, matching
 *  `spoke-runtime.ts#flushProject`'s own posture. Every failure mode is caught by the caller
 *  (`runHubOutboxTick`'s per-project try/catch), so this function is free to let a genuine bug throw
 *  rather than swallow it silently. */
async function flushHubProject(
  project: HubOutboxProject,
  deps: HubOutboxTickDeps,
  ctx: {
    readTodosFn: (dataDir: string) => Promise<TodoItem[]>;
    applyOpFn: (dataDir: string, op: ClusterOp & { hubSeq: number }) => Promise<HubOpOutcome>;
    opSendBudget: OpSendBudget;
    now: () => Date;
    warn?: (message: string) => void;
  },
  report: HubOutboxTickReport,
  targetsReached: Set<ClusterNodeId>,
): Promise<void> {
  let todos: TodoItem[];
  try {
    todos = await ctx.readTodosFn(project.dataDir);
  } catch (err) {
    ctx.warn?.(`cluster hub: outbox tick could not read todos for "${project.projectKey}": ${errorMessage(err)}`);
    return;
  }

  const owed = todos.filter(isOwed);
  if (owed.length === 0) return;

  // Synthetic `pendingSince`, in memory only — see module docblock. A record that already carries
  // one (the ordinary steady-state case) is passed through untouched.
  const nowIso = ctx.now().toISOString();
  const enriched = owed.map((todo) => (todo.pendingSince ? todo : { ...todo, pendingSince: nowIso }));

  const derived = deriveTodoOps({
    nodeId: deps.nodeId,
    projectKey: project.projectKey,
    todos: enriched,
    ackedThroughHubSeq: 0, // see module docblock — always correct for the hub's own derive
    now: ctx.now,
  });
  if (derived.length === 0) return; // every selected record failed to yield an op — nothing owed after all

  const { sent, remaining } = packOpsFrame(derived, {
    scope: 'project',
    projectKey: project.projectKey,
    budget: ctx.opSendBudget,
  });
  if (remaining.length > 0) {
    report.opsDeferred += remaining.length;
    ctx.warn?.(
      `cluster hub: outbox tick capped project "${project.projectKey}" at ${sent.length} of ${derived.length} ` +
        'owed op(s) this tick (send budget) — the rest is picked up next tick',
    );
  }
  if (sent.length === 0) return;

  const alloc = await deps.allocateSeq({ scope: 'project', projectKey: project.projectKey, count: sent.length });

  const applied: (ClusterOp & { hubSeq: number })[] = [];
  for (let k = 0; k < sent.length; k++) {
    const op = sent[k]!;
    const hubSeq = alloc.from + k;
    let outcome: HubOpOutcome;
    try {
      outcome = await ctx.applyOpFn(project.dataDir, { ...op, hubSeq });
    } catch (err) {
      report.opsFailed += 1;
      ctx.warn?.(
        `cluster hub: outbox tick — applying op ${op.opId} (${op.entity}/${op.entityId}) threw at hubSeq ` +
          `${hubSeq}: ${errorMessage(err)} — left unapplied, re-derived next tick`,
      );
      continue;
    }
    if (outcome.accepted) {
      applied.push({ ...op, hubSeq });
      report.opsApplied += 1;
    } else {
      report.opsRejected += 1;
      ctx.warn?.(
        `cluster hub: outbox tick — the hub's own apply refused op ${op.opId} (${op.entity}/${op.entityId}) at ` +
          `hubSeq ${hubSeq}: ${outcome.reason ?? 'no reason given'}. Durable, no write — this record's ` +
          'pendingSince cannot clear from a self-refusal and will keep re-deriving (known residual, see module docblock).',
      );
    }
  }
  if (applied.length === 0) return;

  const targets = deps.connectedNodes().map((nodeId) => ({
    nodeId,
    appliedThroughHubSeq: deps.readWatermark(nodeId, project.projectKey),
  }));
  const { plans, excluded } = planReplicaFanout({
    scope: 'project',
    projectKey: project.projectKey,
    applied,
    targets,
    originNodeId: deps.nodeId,
  });

  report.excluded += excluded.length;
  for (const exclusion of excluded) {
    ctx.warn?.(
      `cluster hub: outbox tick — REPLICATION-EXCLUDED — op "${exclusion.opId}" (entity ${exclusion.entity} ` +
        `${exclusion.entityId}, hubSeq ${exclusion.hubSeq}, ${exclusion.bytes} bytes) cannot be replicated to ` +
        `"${exclusion.nodeId}" — durably applied at the hub; this target will never receive it via replication.`,
    );
  }

  for (const plan of plans) {
    for (const frame of plan.frames) {
      if (deps.sendTo(plan.nodeId, frame)) {
        deps.advanceWatermark(plan.nodeId, project.projectKey, frame.hubSeq);
        report.framesSent += 1;
        targetsReached.add(plan.nodeId);
      } else {
        ctx.warn?.(
          `cluster hub: outbox tick — could not push replica through hubSeq ${frame.hubSeq} to "${plan.nodeId}" — ` +
            'left owed; retried on a later batch or replayed from its next hello (known residual, see module docblock)',
        );
      }
    }
  }
}

/** One tick over every project this hub hosts. Never throws — a project whose read, derive, apply or
 *  fan-out step fails is warned and skipped; every OTHER project in the same tick still runs. */
export async function runHubOutboxTick(deps: HubOutboxTickDeps): Promise<HubOutboxTickReport> {
  const readTodosFn = deps.readTodos ?? readTodosDefault;
  const applyOpFn = deps.applyOp ?? applyOpAtHub;
  const opSendBudget = deps.opSendBudget ?? DEFAULT_OP_SEND_BUDGET;
  const now = deps.now ?? ((): Date => new Date());
  const warn = deps.warn;

  const report = emptyReport();
  const targetsReached = new Set<ClusterNodeId>();

  let projects: readonly HubOutboxProject[];
  try {
    projects = await deps.listProjects();
  } catch (err) {
    warn?.(`cluster hub: outbox tick could not list this hub's projects, skipping this tick: ${errorMessage(err)}`);
    return report;
  }

  for (const project of projects) {
    report.projectsProcessed += 1;
    try {
      await flushHubProject(project, deps, { readTodosFn, applyOpFn, opSendBudget, now, warn }, report, targetsReached);
    } catch (err) {
      warn?.(`cluster hub: outbox tick for project "${project.projectKey}" threw: ${errorMessage(err)}`);
    }
  }

  report.targetsReached = targetsReached.size;
  return report;
}

export interface HubOutboxDeps extends Omit<HubOutboxTickDeps, 'nodeId'> {
  /** This node's own cluster identity, exactly as `cluster/node-identity.ts#loadNodeIdentity` returns
   *  it. `undefined` (never joined a cluster) and `role: 'spoke'` both refuse — checked here, not
   *  left to the caller, mirroring `corpus-mirror-bootstrap.ts#ensureCorpusMirrorConnection`'s own
   *  "only a spoke provisions this" gate, inverted: only a HUB runs this outbox. A spoke already has
   *  `spoke-runtime.ts#startSpokeRuntime`'s own outbox flush. */
  identity: StoredClusterNodeIdentity | undefined;
  intervalMs?: number;
}

export type HubOutboxStatus = 'armed' | 'skipped-no-identity' | 'skipped-not-hub';

/** What `startHubOutbox` hands back — callable (the disposer), with the arm decision hung off it so a
 *  caller/test can assert on state rather than scrape a warn() string. Mirrors
 *  `spoke-runtime.ts#SpokeRuntimeHandle`'s "callable plus readonly fields" shape. */
export type HubOutboxHandle = (() => void) & {
  readonly status: HubOutboxStatus;
  readonly reason?: string;
};

function refuse(status: Exclude<HubOutboxStatus, 'armed'>, reason: string, warn?: (message: string) => void): HubOutboxHandle {
  warn?.(`cluster hub: outbox NOT armed (${status}) — ${reason}`);
  return Object.assign((): void => {}, { status, reason });
}

/**
 * Wires the hub-local outbox tick onto an interval. Never throws into the boot path (constraint 3,
 * matching every other arm-time check in this feature) — every refusal comes back as a named
 * `HubOutboxHandle.status`/`reason` rather than an exception.
 *
 * Idempotent disposer; the interval timer is `unref()`'d so a CLI process can still exit with it
 * armed.
 */
export function startHubOutbox(deps: HubOutboxDeps): HubOutboxHandle {
  const identity = deps.identity;
  if (!identity) {
    return refuse('skipped-no-identity', 'this node has no cluster identity on disk yet', deps.warn);
  }
  if (identity.role !== 'hub') {
    return refuse(
      'skipped-not-hub',
      'this node is a spoke — spoke-runtime.ts already owns its own outbox flush',
      deps.warn,
    );
  }

  const intervalMs = deps.intervalMs ?? DEFAULT_HUB_OUTBOX_INTERVAL_MS;
  const nodeId = identity.nodeId;
  let disposed = false;

  const tick = (): void => {
    if (disposed) return;
    runHubOutboxTick({ ...deps, nodeId }).catch((err: unknown) => {
      deps.warn?.(`cluster hub: outbox tick threw: ${errorMessage(err)}`);
    });
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
  };

  return Object.assign(dispose, { status: 'armed' as const, reason: undefined });
}
