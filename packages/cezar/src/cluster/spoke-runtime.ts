import { join } from 'node:path';
import {
  CLUSTER_PROTOCOL,
  type ClusterAckFrame,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterNodeId,
  type ClusterOp,
  type ClusterPresenceFrame,
  type ClusterProjectKey,
  type ClusterReplicaFrame,
  type ClusterUplinkFrame,
} from '@loki-labs/better-cezar-contract';
import { workspaceConfigPath } from '../paths.ts';
import { applyHubReplica as applyHubReplicaFile, readTodos as readTodosFile, type ApplyHubReplicaInput, type TodoItem } from '../todos.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { loadNodeIdentity } from './node-identity.ts';
import { DEFAULT_OP_SEND_BUDGET, deriveTodoOps, packOpsFrame, type OpSendBudget } from './ops.ts';
import { collectPresence as collectClusterPresence, readPeers } from './peers.ts';
import { applyReplicaFrame, type ReplicaApplyResult } from './replica.ts';

/**
 * The spoke's own presence loop, outbox flush, and its answer to everything the hub sends down the
 * link (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D4 · D5 · D5a · D7 · D8a · D9a ·
 * D11 · D12a · D13 · D15).
 *
 * **Presence makes a node LINKED and VISIBLE (Milestone A). This file also makes tier-1 todo state
 * REPLICATE (Milestone B).** Every `heartbeatMs` it reports capacity, host metrics and repo drift
 * (D14/D14a) over `link.send`, and every `opFlushMs` it derives this node's pending todo edits
 * (`cluster/ops.ts#deriveTodoOps`) and sends them as `ops` frames. One thing this module still does
 * NOT do, a later milestone — do not read "handles downlink frames" as it:
 *
 *  - **Dispatched work is refused, not run.** This node cannot execute a foreign `dispatch` yet, so
 *    it answers with a `freshness` frame carrying `refused: { reason: 'dispatch-not-accepted' }`
 *    rather than staying silent — a hub that hears nothing back cannot tell "refused" from "dead
 *    link" from "crashed mid-run" (D12a's whole point: named reasons, never absence). `relay` is
 *    likewise unbuilt (Milestone D).
 *
 * **The outbox is never a queue this file holds.** `deriveTodoOps` re-derives the owed set from
 * records still marked `pendingSince` on every tick — nothing sent-but-unacked is kept in memory
 * across ticks, so a link outage never grows a backlog here (D5's whole point: the records
 * themselves are the durable intent, the outbox is a re-derivable view over them). What this file
 * DOES hold, per project, is two small watermarks — `ackedThroughHubSeq` (from `ack` frames, fed
 * back into `deriveTodoOps` so an already-durable record is not re-sent) and `appliedThroughHubSeq`
 * (from `replica` frames, fed into `applyHubReplica` so a resumed link's overlap is a no-op) — and
 * losing both on a restart is harmless: `deriveTodoOps` re-derives from `pendingSince` either way,
 * and `applyHubReplica`/`applyReplica` are idempotent against a lower watermark, just re-applying a
 * few changes it already had. Persisting them durably is future work (see the module's own spec
 * section, "Milestone B"), not this increment's.
 *
 * **Which projects get flushed/replicated is discovered from disk, not injected by the caller.**
 * `discoverOutboxProjects` reads this node's own identity + confirmed pairings + the workspace
 * registry — the same three reads `peers.ts#collectPresence` already does for `repoDrift` — so a
 * project confirmed in the cockpit starts flushing on the next tick with no restart and no change
 * to whoever calls `startSpokeRuntime`. `deps.collectOutboxProjects` exists only as a test seam.
 *
 * **The heartbeat never queues a missed beat.** `send()` returning `false` means the link is
 * offline, reconnecting, or over its per-tick send budget — a normal transient state, not an error
 * (`link-client.ts`'s own doc). A presence frame is a claim about *now*; the hub stamps whatever it
 * receives with its OWN arrival time (`peers.ts#markNodeSeen` → `capacityAt`), so replaying a
 * backlog of missed beats on reconnect would let a machine that has slept for an hour arrive
 * claiming "capacity as of an hour ago", stamped as current. Every tick computes a fresh presence
 * and attempts exactly one send; nothing is buffered between ticks, so there is nothing to replay.
 * The outbox flush below follows the exact same idiom for the exact same reason.
 */

/** Matches the hub's own expected presence cadence. */
const DEFAULT_HEARTBEAT_MS = 30_000;

/** Todos are more time-sensitive than a capacity claim — a claim someone made on another machine
 *  should not sit for 30s before this node's board reflects it, or before the hub sees this node's
 *  own edit. Independent of `heartbeatMs` on purpose: the two ticks answer different questions and
 *  a caller may want them decoupled (e.g. a slow heartbeat, fast outbox, on a flaky link). */
const DEFAULT_OP_FLUSH_MS = 5_000;

/** The subset of `ClusterLinkClient` this runtime needs — narrowed so a test can drive it with a
 *  plain fake and no socket. */
export interface SpokeLink {
  send(frame: ClusterUplinkFrame): boolean;
  on(event: 'frame', listener: (frame: ClusterDownlinkFrame) => void): unknown;
  off(event: 'frame', listener: (frame: ClusterDownlinkFrame) => void): unknown;
}

/** One tier-1 project this node flushes/replicates todos for — its hub-known `projectKey` (D2) and
 *  the local `.ai/cezar` dir `todos.ts` reads/writes (the same join every other reader of
 *  `todos.json` uses — `server/cluster-routes.ts#todosDataDir`, `project-context.ts`, `todo-cli.ts`,
 *  `index.ts` — none of them export it as a helper, so it is repeated here too). */
export interface SpokeOutboxProject {
  projectKey: ClusterProjectKey;
  dataDir: string;
}

export interface OutboxDiscovery {
  /** `undefined` before this node has joined a cluster (D1/D17) — never a reason to throw, only a
   *  reason `projects` is always `[]`. */
  nodeId: ClusterNodeId | undefined;
  /** This node's CONFIRMED pairings only (D2) — a proposed-but-unconfirmed one replicates nothing. */
  projects: readonly SpokeOutboxProject[];
}

/** This node's identity + confirmed project pairings, read fresh from disk — the same three reads
 *  `peers.ts#collectPresence` already does to build `repoDrift`, so "this project reports drift" and
 *  "this project's todos flush" are always the same set, with no second source of truth to drift
 *  from the first. */
async function discoverOutboxProjects(
  env: NodeJS.ProcessEnv | undefined,
  warn: ((message: string) => void) | undefined,
): Promise<OutboxDiscovery> {
  const identity = await loadNodeIdentity({ env, warn });
  if (!identity) return { nodeId: undefined, projects: [] };

  const [peers, config] = await Promise.all([readPeers({ env, warn }), loadWorkspaceConfig(workspaceConfigPath(env))]);
  const byId = new Map(config.projects.map((p) => [p.id, p]));

  const projects: SpokeOutboxProject[] = [];
  for (const pairing of peers.pairings) {
    const member = pairing.byNode[identity.nodeId];
    if (!member?.confirmedAt) continue; // proposed-but-unconfirmed — never replicates (D2)
    const project = byId.get(member.projectId);
    if (!project) continue; // paired project since deregistered on this node
    projects.push({ projectKey: pairing.projectKey, dataDir: join(project.root, '.ai/cezar') });
  }
  return { nodeId: identity.nodeId, projects };
}

export interface SpokeRuntimeDeps {
  link: SpokeLink;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
  /** Default 30_000. */
  heartbeatMs?: number;
  /** Test hook; defaults to `cluster/peers.ts#collectPresence`. */
  collectPresence?: () => Promise<ClusterPresenceFrame>;

  /** Default 5_000. */
  opFlushMs?: number;
  /** Test hook; defaults to `discoverOutboxProjects` above (this node's identity + confirmed
   *  pairings, read from disk). */
  collectOutboxProjects?: () => Promise<OutboxDiscovery>;
  /** Test hook; defaults to `todos.ts#readTodos` (D5a: healed, never a raw parse). */
  readTodos?: (dataDir: string) => Promise<TodoItem[]>;
  /** Test hook; defaults to `todos.ts#applyHubReplica`, the only write-down path there is (D7). */
  applyHubReplica?: (dataDir: string, input: ApplyHubReplicaInput) => Promise<ReplicaApplyResult>;
  /** Test hook; defaults to `ops.ts#DEFAULT_OP_SEND_BUDGET`. */
  opSendBudget?: OpSendBudget;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Per-project watermarks this runtime holds IN MEMORY only — see the module doc for why losing
 *  them on restart is harmless rather than a durability gap. */
interface ProjectOutboxState {
  /** Everything at or below this is durably applied at the hub and is not owed (from `ack`). */
  ackedThroughHubSeq: number;
  /** The highest hub order this node has applied from a `replica` push. */
  appliedThroughHubSeq: number;
}

/**
 * Wires the presence heartbeat, the outbox flush, and downlink handling onto an already-dialled
 * `SpokeLink`.
 *
 * Returns a disposer that stops both loops and detaches every listener. Idempotent.
 */
export function startSpokeRuntime(deps: SpokeRuntimeDeps): () => void {
  const warn = deps.warn;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const opFlushMs = deps.opFlushMs ?? DEFAULT_OP_FLUSH_MS;
  const opSendBudget = deps.opSendBudget ?? DEFAULT_OP_SEND_BUDGET;
  const collectPresence =
    deps.collectPresence ?? ((): Promise<ClusterPresenceFrame> => collectClusterPresence({ env: deps.env, warn }));
  const collectOutboxProjects =
    deps.collectOutboxProjects ?? ((): Promise<OutboxDiscovery> => discoverOutboxProjects(deps.env, warn));
  const readTodosFn = deps.readTodos ?? readTodosFile;
  const applyHubReplicaFn = deps.applyHubReplica ?? applyHubReplicaFile;

  let disposed = false;
  // Guards against a slow `collectPresence()` still being in flight when the next tick fires —
  // never two overlapping presence collections (git subprocesses) racing each other.
  let beatInFlight = false;
  // Set on the first missed beat of an outage, cleared on the next delivered one — so a long
  // outage warns ONCE, not once per missed beat.
  let outageWarned = false;

  // Same reentrancy shape as the heartbeat, one tick down: a slow send must never overlap the next
  // flush tick, and a link outage warns once per outage, not once per project per tick.
  let flushInFlight = false;
  let opsOutageWarned = false;
  const projectState = new Map<ClusterProjectKey, ProjectOutboxState>();

  function stateFor(projectKey: ClusterProjectKey): ProjectOutboxState {
    let state = projectState.get(projectKey);
    if (!state) {
      state = { ackedThroughHubSeq: 0, appliedThroughHubSeq: 0 };
      projectState.set(projectKey, state);
    }
    return state;
  }

  const beat = async (): Promise<void> => {
    if (disposed || beatInFlight) return;
    beatInFlight = true;
    try {
      let frame: ClusterPresenceFrame;
      try {
        frame = await collectPresence();
      } catch (err) {
        warn?.(`cluster spoke: presence collection failed, skipping this beat: ${errorMessage(err)}`);
        return;
      }
      if (disposed) return; // dispose() ran while collectPresence() was in flight
      const sent = deps.link.send(frame);
      if (sent) {
        outageWarned = false;
      } else if (!outageWarned) {
        outageWarned = true;
        warn?.(
          'cluster spoke: presence heartbeat not delivered (link offline or over budget) — will keep beating silently until it recovers',
        );
      }
    } finally {
      beatInFlight = false;
    }
  };

  /** One project's share of one flush tick. Never holds anything past this call: on a failed send
   *  the un-packed remainder is simply discarded, because the NEXT tick re-derives the same (still
   *  `pendingSince`) records from disk (D5) — there is nothing here that would need to be "resumed"
   *  from, which is what keeps a down link from ever growing a backlog in this process. */
  async function flushProject(nodeId: ClusterNodeId, project: SpokeOutboxProject): Promise<'sent' | 'nothing-owed' | 'link-down'> {
    let todos: TodoItem[];
    try {
      todos = await readTodosFn(project.dataDir);
    } catch (err) {
      warn?.(`cluster spoke: outbox flush could not read todos for "${project.projectKey}": ${errorMessage(err)}`);
      return 'nothing-owed';
    }
    if (disposed) return 'nothing-owed';

    const state = stateFor(project.projectKey);
    const owed = deriveTodoOps({
      nodeId,
      projectKey: project.projectKey,
      todos,
      ackedThroughHubSeq: state.ackedThroughHubSeq,
    });
    // Nothing pending: send NOTHING, never an empty frame (the house rule this file's dispatch
    // decline already follows — decline to answer rather than answer falsely; here, decline to
    // send rather than send vacuously).
    if (owed.length === 0) return 'nothing-owed';

    let remaining: readonly ClusterOp[] = owed;
    let sentAny = false;
    for (let frames = 0; frames < opSendBudget.maxFramesPerTick && remaining.length > 0; frames++) {
      const packed = packOpsFrame(remaining, { scope: 'project', projectKey: project.projectKey, budget: opSendBudget });
      if (packed.sent.length === 0) break; // unreachable: `remaining` is non-empty, `packOpsFrame` always sends ≥1
      if (!deps.link.send(packed.frame)) {
        return sentAny ? 'sent' : 'link-down';
      }
      sentAny = true;
      remaining = packed.remaining;
    }
    return sentAny ? 'sent' : 'nothing-owed';
  }

  const flushOps = async (): Promise<void> => {
    if (disposed || flushInFlight) return;
    flushInFlight = true;
    try {
      let discovery: OutboxDiscovery;
      try {
        discovery = await collectOutboxProjects();
      } catch (err) {
        warn?.(`cluster spoke: outbox flush could not discover this node's projects, skipping this tick: ${errorMessage(err)}`);
        return;
      }
      if (disposed) return;
      // No identity yet, or no confirmed pairing: nothing is owed by construction, not an error —
      // the normal state of a node that has not paired a project yet (D2).
      if (!discovery.nodeId || discovery.projects.length === 0) return;

      let anySent = false;
      let linkDown = false;
      for (const project of discovery.projects) {
        if (disposed) return;
        const outcome = await flushProject(discovery.nodeId, project);
        if (outcome === 'sent') anySent = true;
        else if (outcome === 'link-down') {
          linkDown = true;
          break; // the link is down for this node, not just this project — stop, don't race it
        }
      }

      if (linkDown) {
        if (!opsOutageWarned) {
          opsOutageWarned = true;
          warn?.(
            'cluster spoke: outbox flush not delivered (link offline or over budget) — nothing queued, the outbox re-derives from records next tick',
          );
        }
      } else if (anySent) {
        opsOutageWarned = false;
      }
    } finally {
      flushInFlight = false;
    }
  };

  /** `ack` — `throughHubSeq` is the ONLY thing that may retire an owed op (never `results`, which
   *  exists for a future synchronous claim-confirmation correlation, not for outbox bookkeeping —
   *  see `clusterAckFrameSchema`'s own doc). Monotonic: an out-of-order or resent ack must never
   *  move the watermark backward. Scoped to `project` on purpose — this build derives and sends
   *  only todo ops (`scope: 'project'`); a workspace-scope ack (reports-triage, notes, roster) has
   *  no outbox here to retire anything from. */
  function applyAck(frame: ClusterAckFrame): void {
    if (frame.scope !== 'project' || !frame.projectKey) return;
    const state = stateFor(frame.projectKey);
    if (frame.throughHubSeq > state.ackedThroughHubSeq) state.ackedThroughHubSeq = frame.throughHubSeq;
  }

  /** `replica` — the only write-down path there is (D7): applied through the store API under the
   *  existing lease, never by writing the file, so `todos.ts`'s `fs.watch` fires and the Tasks
   *  board updates with no new read path anywhere. */
  async function applyReplicaDownlink(frame: ClusterReplicaFrame): Promise<void> {
    if (frame.scope !== 'project' || !frame.projectKey) {
      warn?.(
        `cluster spoke: ignoring replicated ${frame.scope} changes — only project-scoped todo replication is wired in this build`,
      );
      return;
    }

    const discovery = await collectOutboxProjects();
    const project = discovery.projects.find((p) => p.projectKey === frame.projectKey);
    if (!project || !discovery.nodeId) {
      warn?.(
        `cluster spoke: ignoring replicated changes for "${frame.projectKey}" — not a project this node has confirmed pairing for`,
      );
      return;
    }
    if (disposed) return;

    const state = stateFor(frame.projectKey);

    let local: TodoItem[];
    try {
      local = await readTodosFn(project.dataDir);
    } catch (err) {
      warn?.(`cluster spoke: could not read local todos for "${frame.projectKey}" before applying replica: ${errorMessage(err)}`);
      return;
    }
    if (disposed) return;

    // This node's own outstanding (unacknowledged) edits — what `applyReplica`'s correction pass
    // compares the hub's applied result against (D4: "the cockpit must SHOW that it changed rather
    // than silently swapping the value under the reader").
    const pending = deriveTodoOps({
      nodeId: discovery.nodeId,
      projectKey: project.projectKey,
      todos: local,
      ackedThroughHubSeq: state.ackedThroughHubSeq,
    });

    // Pure pass first (`replica.ts#applyReplicaFrame`): its one job here is what `applyReplica`
    // alone cannot do — advance the watermark to `frame.hubSeq` even when `changes` is empty (a
    // keepalive push, D16). Its `.todos`/`.corrections` are NOT the write: D7 requires the write to
    // go through the store API under the lease, which re-reads fresh rather than trusting this
    // snapshot — so only the watermark from this pure pass is used below, never its record state.
    const preview = applyReplicaFrame(frame, { local, pending, appliedThroughHubSeq: state.appliedThroughHubSeq });

    let result: ReplicaApplyResult;
    try {
      result = await applyHubReplicaFn(project.dataDir, {
        changes: frame.changes,
        pending,
        appliedThroughHubSeq: state.appliedThroughHubSeq,
      });
    } catch (err) {
      warn?.(`cluster spoke: applying replicated changes for "${frame.projectKey}" failed: ${errorMessage(err)}`);
      return;
    }
    if (disposed) return;

    state.appliedThroughHubSeq = Math.max(result.appliedThroughHubSeq, preview.appliedThroughHubSeq);
    if (result.corrections.length > 0) {
      warn?.(`cluster spoke: hub corrected ${result.corrections.length} field(s) for "${frame.projectKey}" on replica apply`);
    }
  }

  const handleDispatch = async (dispatchId: string, projectKey: string): Promise<void> => {
    let presence: ClusterPresenceFrame;
    try {
      presence = await collectPresence();
    } catch (err) {
      warn?.(`cluster spoke: cannot decline dispatch ${dispatchId} — presence collection failed: ${errorMessage(err)}`);
      return;
    }
    if (disposed) return;
    const drift = presence.repoDrift.find((d) => d.projectKey === projectKey);
    if (!drift) {
      // `clusterFreshnessFrameSchema` extends the repo-freshness fields (headSha, ahead, behind,
      // dirty, merging) UNCONDITIONALLY — even a plain "not accepted" refusal has to carry them.
      // Without a matching `repoDrift` entry (project not paired/confirmed on this node) there is
      // no truthful value for any of them, and fabricating one puts a lie on the wire. Decline to
      // answer at all rather than decline falsely.
      warn?.(
        `cluster spoke: cannot decline dispatch ${dispatchId} truthfully — no repo-freshness data for project "${projectKey}" (not paired/confirmed here)`,
      );
      return;
    }
    const decline: ClusterFreshnessFrame = {
      type: 'freshness',
      protocol: CLUSTER_PROTOCOL,
      projectKey: drift.projectKey,
      headSha: drift.headSha,
      ahead: drift.ahead,
      behind: drift.behind,
      dirty: drift.dirty,
      merging: drift.merging,
      refused: { dispatchId, reason: 'dispatch-not-accepted' },
    };
    if (!deps.link.send(decline)) {
      warn?.(
        `cluster spoke: could not deliver the decline for dispatch ${dispatchId} (link offline) — the next presence beat is the fallback`,
      );
    }
  };

  const onFrame = (frame: ClusterDownlinkFrame): void => {
    if (disposed) return;
    switch (frame.type) {
      case 'dispatch':
        handleDispatch(frame.dispatchId, frame.projectKey).catch((err: unknown) => {
          warn?.(`cluster spoke: dispatch handling threw for ${frame.dispatchId}: ${errorMessage(err)}`);
        });
        break;
      case 'replica':
        applyReplicaDownlink(frame).catch((err: unknown) => {
          warn?.(`cluster spoke: applying replicated changes for ${frame.projectKey ?? frame.scope} threw: ${errorMessage(err)}`);
        });
        break;
      case 'ack':
        applyAck(frame);
        break;
      case 'relay':
        warn?.(`cluster spoke: relay requested for run ${frame.runId} — relay is not built yet`);
        break;
      case 'welcome':
      case 'refuse':
        // Owned by `ClusterLinkClient` itself — not a gap, so it does not warn.
        break;
    }
  };

  deps.link.on('frame', onFrame);
  beat().catch((err: unknown) => {
    warn?.(`cluster spoke: initial presence beat threw: ${errorMessage(err)}`);
  });
  const heartbeatTimer = setInterval(() => {
    beat().catch((err: unknown) => {
      warn?.(`cluster spoke: presence beat threw: ${errorMessage(err)}`);
    });
  }, heartbeatMs);
  // A CLI process must be able to exit with a link still open; the heartbeat must never be the
  // thing holding the event loop alive.
  heartbeatTimer.unref?.();

  flushOps().catch((err: unknown) => {
    warn?.(`cluster spoke: initial outbox flush threw: ${errorMessage(err)}`);
  });
  const flushTimer = setInterval(() => {
    flushOps().catch((err: unknown) => {
      warn?.(`cluster spoke: outbox flush threw: ${errorMessage(err)}`);
    });
  }, opFlushMs);
  flushTimer.unref?.();

  return (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeatTimer);
    clearInterval(flushTimer);
    deps.link.off('frame', onFrame);
  };
}
