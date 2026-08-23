import { join } from 'node:path';
import {
  CLUSTER_PROTOCOL,
  type ClusterAckFrame,
  type ClusterAckResult,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterNodeId,
  type ClusterOp,
  type ClusterPresenceFrame,
  type ClusterProjectKey,
  type ClusterReplicaFrame,
  type ClusterUplinkFrame,
  type ClusterWatermark,
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
 * few changes it already had.
 *
 * **AMENDED 2026-08-23 (D38) — those two watermarks are now REPORTED, and still not persisted.**
 * This paragraph used to end *"Persisting them durably is future work (see the module's own spec
 * section, Milestone B), not this increment's"*, which reads as a gap waiting to be filled. It is
 * not one. They are exposed live through `SpokeRuntimeHandle.watermarks()` so
 * `link-client.ts#sendHello` can stop hardcoding `hello.watermarks: []` and a RECONNECT can resume
 * instead of replaying the whole scope. Persisting them across a process RESTART is a different
 * thing and is deliberately declined: in memory, `[]` after a restart is TRUE and a full replay is
 * the correct outcome, whereas a persisted position would let a restarted node assert a place it
 * cannot vouch for — trading a bounded, idempotent over-send for a silent under-send. See
 * `currentWatermarks` for the full argument and for why a `{0, 0}` project is omitted rather than
 * advertised as zero.
 *
 * **Which projects get flushed/replicated is discovered from disk, not injected by the caller.**
 * `discoverOutboxProjects` reads this node's own identity + confirmed pairings + the workspace
 * registry — the same three reads `peers.ts#collectPresence` already does for `repoDrift` — so a
 * project confirmed in the cockpit starts flushing on the next tick with no restart and no change
 * to whoever calls `startSpokeRuntime`. `deps.collectOutboxProjects` exists only as a test seam.
 *
 * **The sweep rotates, because the early break is not always about the link (2026-08-23).** One
 * flush tick walks every project, and a project whose FIRST frame is refused ends the sweep — the
 * remaining projects are not read, not derived, not attempted. That break is right: a refused send
 * usually means the link is offline, and marching the rest of the list into the same refusal is
 * pointless work. What was wrong is where the NEXT sweep started. `discoverOutboxProjects` walks
 * `peers.pairings` in insertion order, so the order is stable across ticks, and the sweep used to
 * restart at index 0 every time — so a project that refuses reliably permanently starves every
 * project behind it, and nothing anywhere reports it.
 *
 * "Reliably" is the load-bearing word, and it is reachable: `link-client.ts#send` returns `false`
 * for THREE conditions, and only the first matches this break's premise. Offline is transient.
 * Over the per-window frame budget is transient but ORDER-DEPENDENT — the projects at the front
 * spend the budget the ones at the back then can't have. Over `CLUSTER_FRAME_MAX_BYTES` is neither:
 * `packOpsFrame` deliberately emits an oversized single op rather than stalling on it, the link
 * refuses that frame, and it will refuse the identical frame on every tick until the RECORD
 * changes. One unrepresentable todo in one project was therefore a silent, permanent outage for
 * every project after it — misreported as "link offline or over budget", while presence heartbeats
 * kept succeeding and the cockpit's link row stayed green.
 *
 * So the sweep now resumes just past whatever blocked it (`flushCursor`), which bounds the blast
 * radius of a stuck project to that project. A clean sweep resets the cursor, so the healthy path
 * is unchanged: registry order, every project, every tick. This is the spoke-side half of the rule
 * `replica-fanout.ts` already applies on the hub side (D29): one unrepresentable record must never
 * be collateral damage for the other records or the other targets.
 *
 * **What this does NOT fix**, deliberately, because it needs a decision this file cannot make: the
 * blocked project still never flushes, and still cannot say why. The hub side names the case
 * (`replica-fanout.ts` returns `excluded`, never optional, so the report cannot be swallowed); the
 * spoke has no equivalent, because `SpokeLink.send` returns a bare `boolean` and "too big" is
 * indistinguishable here from "offline". Making the spoke report it means widening that contract,
 * which is `link-client.ts`'s call, not this module's.
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

/** Spelled out in full before the line falls back to a bare count — enough to identify the ops
 *  without letting one 500-result frame write a 500-clause log line. */
const REFUSALS_DETAILED_MAX = 3;

/** A refusal carrying the winner's `startedTaskId` is a D9a claim loss: `hub-apply.ts#claimFields`
 *  is the only thing in the tree that populates `fields` on an `accepted: false`, and it populates
 *  it with exactly that key. So the field's presence IS the "this was a claim" signal — there is no
 *  op-kind marker on the wire to read instead. */
function isClaimRefusal(result: ClusterAckResult): boolean {
  const claim = result.fields?.['startedTaskId'];
  return typeof claim === 'string' && claim.length > 0;
}

function describeRefusal(result: ClusterAckResult): string {
  const reason = result.reason ?? 'no reason given';
  const head = `op ${result.opId} (hubSeq ${result.hubSeq}): ${reason}`;
  if (!isClaimRefusal(result)) return head;
  const claim = result.fields?.['startedTaskId'] as string;
  const on = result.fields?.['startedOn'];
  return `${head} — held by run "${claim}"${typeof on === 'string' && on ? ` on node "${on}"` : ''}`;
}

/**
 * The ack's refusals, made visible. See `applyAck` for why this reports rather than settles, and
 * why one refusal in `results` is the only copy of that verdict there will ever be.
 *
 * Not scoped to `project`: a verdict can only ever be about an op THIS link sent, so a refusal is
 * worth naming whatever scope it arrives under, even though this build's outbox derives project
 * ops only. The scope guard in `applyAck` is about the WATERMARK, which is per-scope, and does not
 * generalise to the report.
 */
function reportRefusals(frame: ClusterAckFrame, warn: ((message: string) => void) | undefined): void {
  if (!warn) return;
  const results = frame.results ?? [];
  const refused = results.filter((result) => !result.accepted);
  if (refused.length === 0) return;

  const detail = refused.slice(0, REFUSALS_DETAILED_MAX).map(describeRefusal).join('; ');
  const more = refused.length > REFUSALS_DETAILED_MAX ? `; +${refused.length - REFUSALS_DETAILED_MAX} more` : '';
  const claims = refused.filter(isClaimRefusal).length;
  // Named explicitly, because the natural reading of "the hub refused the claim" is "so this node
  // did not start" — and under D9a's asynchronous path that reading is exactly backwards. The local
  // start already happened; only the hub's copy was refused.
  const claimNote = claims
    ? ` — ${claims} of them a claim this node LOST (D9a): a run started here for that claim is NOT stopped by this ack`
    : '';
  warn(
    `cluster spoke: the hub REFUSED ${refused.length} of ${results.length} op(s) on this ${frame.scope} ack` +
      `${frame.projectKey ? ` (project ${frame.projectKey})` : ''}${claimNote}. Refused ops are never ` +
      `replicated back, so the record stays pending and re-derives every flush tick until connect-time ` +
      `replay settles it (D35): ${detail}${more}`,
  );
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
 * What `startSpokeRuntime` hands back: **still the disposer it always was**, with the watermark
 * reader hung off it (D38).
 *
 * Callable rather than `{ stop, watermarks }` deliberately. `server/cluster-routes.ts` calls the
 * return value directly (`stopHeartbeat()`), that file is owned by another session right now, and
 * an object would break its typecheck the moment this landed — for a feature whose consumer is not
 * wired yet. `startSpokeRuntime` is not exported from `src/index.ts`, so this is an internal shape
 * with exactly one in-repo caller and no published-API cost either way; when the wiring lands, this
 * can become a plain object in the same change that updates that call site.
 *
 * **CORRECTED 2026-08-23, same session — the wiring landed, so the second half of that reasoning is
 * spent.** *"a feature whose consumer is not wired yet"* was true when this type was written and is
 * now false: `cluster-routes.ts:1173` supplies `watermarks: () => spokeRuntime?.watermarks() ?? []`
 * (late-bound, because `ClusterLinkClient` is constructed BEFORE this runtime and needs a reference
 * to something that does not exist yet). The callable shape is therefore no longer load-bearing and
 * the plain-object refactor named above is now free to happen; it is left as-is only because
 * nothing needs it.
 */
export type SpokeRuntimeHandle = (() => void) & {
  /**
   * Where this node is, RIGHT NOW, for every scope it genuinely has a position for — the answer
   * `link-client.ts#sendHello` needs for `hello.watermarks`. A getter, never a snapshot:
   * `sendHello` runs again on every reconnect and must see the position as of that moment, not as
   * of whenever the link was constructed.
   *
   * **CORRECTED 2026-08-23, same session.** This said `sendHello` *"hardcodes to `[]` today
   * (D38)"*, which was the whole reason this accessor exists and stopped being true within the
   * session that wrote it. `link-client.ts` now takes a `watermarks?: () => readonly
   * ClusterWatermark[]` option and calls it through `helloWatermarks()`, which narrows each entry
   * to the five wire fields, caps the list at `.max(500)`, and catches a throwing provider —
   * failing toward over-sending every time. Read that method, not this comment, for what actually
   * reaches the frame.
   */
  readonly watermarks: () => readonly ClusterWatermark[];
};

/**
 * Wires the presence heartbeat, the outbox flush, and downlink handling onto an already-dialled
 * `SpokeLink`.
 *
 * Returns a disposer that stops both loops and detaches every listener. Idempotent. The disposer
 * also carries `watermarks()` — see `SpokeRuntimeHandle`.
 */
export function startSpokeRuntime(deps: SpokeRuntimeDeps): SpokeRuntimeHandle {
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
  // Where the next sweep starts — see "The sweep rotates" in the module doc. NOT the accumulating
  // state D5 forbids: one integer bounded by the project count, holding no op and no ordering
  // promise, and losing it on restart costs a single tick of the old front-to-back order.
  let flushCursor = 0;
  const projectState = new Map<ClusterProjectKey, ProjectOutboxState>();

  function stateFor(projectKey: ClusterProjectKey): ProjectOutboxState {
    let state = projectState.get(projectKey);
    if (!state) {
      state = { ackedThroughHubSeq: 0, appliedThroughHubSeq: 0 };
      projectState.set(projectKey, state);
    }
    return state;
  }

  /**
   * D38 — `hello.watermarks`, read live off `projectState` at the moment of the call.
   *
   * **Reports, never persists**, and that restraint is the design rather than an omission. These
   * positions are in-memory by decision (module doc above), so after a process RESTART this node
   * genuinely does not know where it is, `[]` is the truthful answer, and a full replay is the
   * correct outcome. Writing them to disk would let a restarted node re-assert a position it cannot
   * vouch for, turning a bounded over-send into a silent UNDER-send — records the hub believes were
   * delivered and never ships again. Over-sending costs bandwidth and is idempotent
   * (`replica.ts#applyReplica` skips at or below the watermark); under-sending loses writes. The
   * defect D38 closes is narrower and is entirely in memory: a RECONNECT without a restart — socket
   * drop, hub restart, network blip — where these positions are still live and `sendHello` throws
   * them away.
   *
   * **A `{0, 0}` project is omitted, not reported as zero.** `stateFor` is called by the flush path
   * too, so merely *attempting* one send for a project mints an entry — a project that has never
   * been acked and never received a replica would otherwise be advertised as a position, and this
   * node holds none for it. Absence says "I do not know"; an explicit zero says "I know, and it is
   * zero", and only the first is true here. (The hub happens to treat both the same way today —
   * `hub-router.ts` deletes then re-seeds, and a missing key replays from zero — so this costs
   * nothing now and cannot mislead later.)
   *
   * Every entry is `scope: 'project'` because every entry can only be: `applyAck` and
   * `applyReplicaDownlink` both take their scope guard BEFORE calling `stateFor`, and the flush
   * path's projects come from `discoverOutboxProjects`, which is project-scoped by construction. A
   * workspace-scoped position would need its own map, not a widened label on this one.
   *
   * `updatedAt` is left off: it is optional on the wire, and this module tracks no moment at which
   * a position last moved. Stamping the read time would answer a different question than the field
   * asks, in a field a reader would reasonably trust.
   *
   * **What reporting this MADE WORSE, and it is not this function's bug to fix (2026-08-23).**
   * `appliedThroughHubSeq` is advanced to whatever a `replica` frame DECLARES as its `hubSeq`
   * (`applyReplicaDownlink` below, via `replica.ts#applyReplicaFrame`'s `max(..., frame.hubSeq)` —
   * which exists so an empty keepalive push still advances, D16). A frame whose `hubSeq` outruns
   * what it actually delivered — D29's oversized exclusion, D30's stale hub watermark — therefore
   * marks the gap applied. That used to be bounded by the process: this position was in memory, a
   * reconnect reported nothing, the hub re-seeded from zero and replayed the gap away. Now the
   * node ASSERTS the inflated position on every `hello`, `hub-router.ts` seeds its watermark
   * straight from it, and replay computes nothing owed below it — so a gap that used to heal on
   * the next reconnect becomes permanent on BOTH sides. Reporting the truth this module holds is
   * still right; the defect is that the position it holds can be wrong, and the fix is where a
   * frame's `hubSeq` is chosen (`replica-fanout.ts`), never a fudge here. Pinned by the test "a
   * frame whose `hubSeq` outruns what it delivered marks the gap applied".
   */
  function currentWatermarks(): readonly ClusterWatermark[] {
    const marks: ClusterWatermark[] = [];
    for (const [projectKey, state] of projectState) {
      if (state.appliedThroughHubSeq === 0 && state.ackedThroughHubSeq === 0) continue;
      marks.push({
        scope: 'project',
        projectKey,
        appliedThroughHubSeq: state.appliedThroughHubSeq,
        ackedThroughHubSeq: state.ackedThroughHubSeq,
      });
    }
    return marks;
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
      const projects = discovery.projects;
      const start = flushCursor % projects.length; // `length > 0` — the guard above already returned
      for (let i = 0; i < projects.length; i++) {
        if (disposed) return;
        const project = projects[(start + i) % projects.length]!;
        const outcome = await flushProject(discovery.nodeId, project);
        if (outcome === 'sent') anySent = true;
        else if (outcome === 'link-down') {
          linkDown = true;
          // Whatever refused this frame will refuse the rest of this sweep too, so stop rather than
          // race it — but resume the NEXT sweep just past the project that blocked this one, so the
          // tail is never permanently behind a head that fails reliably. See `flushCursor`.
          flushCursor = (start + i + 1) % projects.length;
          break;
        }
      }
      // A sweep that reached every project owes nobody a turn, so the next one starts at the top
      // again: on the healthy path the order is exactly the registry order, on every tick.
      if (!linkDown) flushCursor = 0;

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

  /** `ack` — `throughHubSeq` is the ONLY thing that may retire an owed op (never `results`, see
   *  below). Monotonic: an out-of-order or resent ack must never move the watermark backward.
   *  Scoped to `project` on purpose — this build derives and sends only todo ops
   *  (`scope: 'project'`); a workspace-scope ack (reports-triage, notes, roster) has no outbox here
   *  to retire anything from.
   *
   *  **AMENDED 2026-08-23 (D35).** The retirement rule above is unchanged and still correct. What
   *  was wrong is the reason this file gave for ignoring `results` — *"exists for a future
   *  synchronous claim-confirmation correlation, not for outbox bookkeeping"* — which read as
   *  "nothing here is owed anything by it" and left the array unread by anything at all. A refusal
   *  in `results` is the ONLY signal a refusal ever produces: `hub-router.ts` fans out accepted ops
   *  ONLY (*"a rejected op was not applied to the hub's store, so replicating it would push a value
   *  the hub itself refused"*), so a refused op gets no `replica` frame, ever, from any node — and
   *  `replica` is the only thing that clears `pendingSince`. Discarding the ack's verdict therefore
   *  did not defer the answer to a future milestone; it threw away the answer's only copy, and the
   *  record re-derives with a fresh `opId` on every 5 s tick forever (D35's leak).
   *
   *  **This reports the refusal; it deliberately does NOT settle the record**, and the two are not
   *  the same job. Settling needs `opId -> entity`, and this file cannot form that mapping without
   *  holding a sent-but-unacked map across ticks — the one thing the module doc says it never does,
   *  and the thing that makes a link outage harmless here. (`ops.ts#deriveTodoOps` stamps
   *  `opId: newOpId()` fresh on every derive, so re-deriving from disk cannot recover the mapping
   *  either — note that this contradicts that function's own *"Deterministic: called twice over the
   *  same state it produces the same ops"* docblock.) D35's resolution puts the settling in
   *  connect-time replay instead. Until that lands, a claim this node LOST is a run it has already
   *  started and will not stop — so the refusal being *visible* is the whole of what this file can
   *  honestly contribute, and silence was the worst of the available options.
   *
   *  One line per FRAME, never one per result (`hub-router.ts`'s own rule for the same reason: a
   *  frame may legally carry `CLUSTER_OPS_PER_FRAME_MAX` results). It is NOT deduplicated across
   *  frames: a record stuck in D35's re-derivation loop will restate its refusal every tick, and
   *  that repetition is a true report of a real, ongoing leak — suppressing it would hide the
   *  defect and could equally hide a genuinely new collision. */
  function applyAck(frame: ClusterAckFrame): void {
    reportRefusals(frame, warn);
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

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    clearInterval(heartbeatTimer);
    clearInterval(flushTimer);
    deps.link.off('frame', onFrame);
  };

  // `watermarks` keeps answering after `dispose()`, on purpose: the positions it reports remain a
  // true statement of where this runtime got to, and a disposed runtime returning `[]` would be a
  // fabricated "I am at zero" for the one caller (`sendHello`) whose whole job is not to say that.
  return Object.assign(dispose, { watermarks: currentWatermarks });
}
