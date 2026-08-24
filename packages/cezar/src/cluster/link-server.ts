import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_LINK_PATH,
  CLUSTER_PROTOCOL,
  CLUSTER_PROTOCOL_MAJOR,
  clusterUplinkFrameSchema,
  type ClusterDownlinkFrame,
  type ClusterLinkRefuseReason,
  type ClusterNodeId,
  type ClusterUplinkFrame,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { verifyClusterFrame, LINK_PRINCIPAL_MAX_AGE_MS, type SignedClusterFrame } from './enrollment.ts';
import { lookupNodeSecret } from './node-secrets.ts';

/**
 * The hub end of the link: the `/api/v1/cluster/link` upgrade and frame routing (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D4 · D13 · "API contracts").
 *
 * **The upgrade guard here is its OWN, and that is the whole security point of this file.**
 * `server/ws.ts`'s guard admits browser ORIGINS — it exists to tell the cockpit apart from a foreign
 * page. A node link is authenticated by a per-node HMAC signature and must not be admitted by an
 * origin check; symmetrically, a node-authenticated socket must never gain cockpit topics. Two
 * different questions, two different guards, and conflating them would let either one grant the
 * other's access.
 *
 * **Bounds are enforced here, not hoped for**: `CLUSTER_FRAME_MAX_BYTES` as the socket's
 * `maxPayload`, `CLUSTER_OPS_PER_FRAME_MAX` on an `ops` frame, and a per-tick send budget so one
 * node's backlog cannot monopolise the link.
 *
 * **A refusal is a stated reason, never a silent drop** (D13). A `protocol.major` mismatch refuses
 * the whole link and shows it in the cockpit, because a partial apply that looks complete is the
 * worse failure. A minor skew is fine and expected — the box self-deploys ~10×/day and the Mac lags,
 * so version skew is permanent, not transient.
 *
 * **CORRECTED 2026-08-23 (D28/F4) — this claim covers OUTGOING frames now too, and used to be
 * false for two of `writeFrame`'s three failure paths.** An oversized outgoing frame warned; a
 * socket that was no longer open, and a send BUDGET run dry, both `return false`d in silence —
 * measured as reachable in practice for the budget path specifically, not merely theoretical (see
 * `hub-router.ts`'s own D28 fix for why an unconfirmed write being recorded as delivered is the
 * actual hazard this silence fed). All three paths now warn, from inside `writeFrame` itself.
 */

/**
 * How the claimed nodeId + signed principal ride on the raw upgrade request. There is no hostname
 * routing to resolve a secret from (every node dials the same URL), so the nodeId travels as its
 * own, UNSIGNED header — used only to pick which node's secret to attempt verification against.
 * Trust never rests on this header alone: `authenticateLinkUpgrade` only admits the connection once
 * `verifyClusterFrame` has checked the signature against that node's actual secret, and it re-checks
 * the verified payload's own `nodeId` against this one before returning `ok: true`.
 */
export const CLUSTER_LINK_NODE_HEADER = 'x-cezar-cluster-node';
export const CLUSTER_LINK_PRINCIPAL_HEADER = 'x-cezar-cluster-principal';
export const CLUSTER_LINK_SIGNATURE_HEADER = 'x-cezar-cluster-signature';
/** Set on the HTTP-level refusal response (pre-handshake) so a CLI or curl session debugging a
 *  failed `cluster join` can see WHY without a second round trip. Never trusted as an application
 *  signal by anything other than `ClusterLinkClient`'s own `unexpected-response` handler. */
export const CLUSTER_LINK_REFUSE_REASON_HEADER = 'x-cezar-cluster-refuse-reason';

/** Same cadence as `server/ws.ts`'s cockpit heartbeat — reaps a spoke that stops answering pings
 *  (sleep, a dead network path) so `connectedNodes()` reflects reality rather than a stale TCP
 *  handle. */
export const HEARTBEAT_MS = 30_000;

/**
 * D40a. How long a socket may sit upgraded without having said ONE thing this hub can use, before
 * the hub ends it with `handshake-timeout`. Enforced on the existing reap tick rather than a timer
 * per node, so the granularity is `HEARTBEAT_MS` and the real cut lands somewhere in
 * [HELLO_DEADLINE_MS, HELLO_DEADLINE_MS + HEARTBEAT_MS).
 *
 * **This is the only cover for the second of the two wedges**, and the spoke cannot supply it. Its
 * `handshakeTimeoutMs` is `ws`'s `handshakeTimeout`, which bounds the HTTP 101 upgrade — and in this
 * failure the upgrade SUCCEEDS. What follows is a `hello` the hub drops as unparseable (D13: one bad
 * frame is warned about, never a teardown), so `helloReceived` stays false, the node is never served
 * and never reaped, because ping/pong keeps `alive` true indefinitely. Measured on a real socket
 * pair: still `connecting` at t+13.2s with no retry scheduled, past the client's own 10s timeout.
 *
 * Generous on purpose. The honest client sends its `hello` from `ws.on('open')`, so the only spokes
 * this can reach are ones that said nothing usable for half a minute — and being cut is recoverable
 * (`handshake-timeout` is an ordinary retried reason, unlike `protocol-major`), where being wedged
 * is not.
 */
export const HELLO_DEADLINE_MS = 30_000;

/** Per-node send budget: a spoke offline for hours, or a hub with a large backlog to push down,
 *  must not be able to starve every OTHER node sharing this process's event loop and bandwidth. */
export const SEND_BUDGET_FRAMES_PER_TICK = 100;
export const SEND_BUDGET_TICK_MS = 1_000;

/**
 * What `onFrame` may return instead of a bare array, when the router needs to know whether each
 * reply actually reached the socket (D28).
 *
 * **Why this exists at all.** The reply array is written by `onMessage` below, and until 2026-08-23
 * that loop was `for (const reply of replies) this.writeFrame(node, reply);` — the boolean
 * DISCARDED. `writeFrame` returns false for a closed socket, for an oversized frame (warned) and for
 * a budget-exhausted one (`SEND_BUDGET_FRAMES_PER_TICK`, silently), so a caller that recorded a
 * returned frame as delivered was recording a fiction. `hub-router.ts`'s `ops` case did exactly
 * that: it checked `sendTo`'s boolean before advancing a PUSHED node's replica watermark and
 * advanced the ORIGIN's unconditionally, three lines away — the origin being the one direction the
 * design says must never lose a write. This is the missing half of that check, and it is deliberately
 * a REPORT rather than a return value: the writing happens after `onFrame` has already resolved, so
 * there is nothing left to return it into.
 *
 * **A bare `ClusterDownlinkFrame[]` stays legal**, and is what every caller that does not care
 * returns (`link-server.test.ts`, `cluster-link-activation.test.ts`'s directly-built hubs). Making
 * the richer shape mandatory would have forced every one of them to supply a callback they have no
 * use for, and an unused callback is exactly the thing that decays into a fake.
 */
export interface ClusterFrameReplies {
  readonly frames: readonly ClusterDownlinkFrame[];
  /**
   * Called EXACTLY ONCE for every frame in `frames`, in order, before `onMessage` returns.
   * `delivered` is `writeFrame`'s own answer — true only if the frame was handed to the socket.
   *
   * **Frames after the first undelivered one are never written, and are reported `false`.** They are
   * not skipped silently: a caller that advances a watermark per delivered frame has to see a verdict
   * for each one, or "not reported" and "delivered" become indistinguishable — which is the defect
   * this whole interface exists to close, reintroduced one level up.
   */
  readonly onWritten?: (frame: ClusterDownlinkFrame, delivered: boolean) => void;
  /**
   * Close this node's socket and drop it from the roster AFTER the frames above are written, with
   * `reason` as the RFC 6455 close reason (1008, Policy Violation) so the spoke can render a stated
   * cause rather than a bare disconnect.
   *
   * **D40b.** A `refuse` FRAME is only advice: a peer that ignores it keeps a live socket, a live
   * socket is a `connectedNodes()` entry, and a `connectedNodes()` entry is a `planReplicaFanout`
   * target. So a router that has decided a node may not be served could not, before this existed,
   * enforce that decision by replying at all — the strongest thing it could say was a sentence the
   * other end was free to discard. This is how it says "and stop serving it" without being handed
   * the socket it has no business holding (module doc: this file has no opinion on what a frame
   * MEANS, and the router never has to know a socket exists).
   *
   * Frames first, close second, and **the close is UNCONDITIONAL** — it does not depend on the
   * refusal having been delivered. The reason a node is cut off is never "the spoke agreed to it":
   * an oversized or budget-dropped `refuse` would otherwise leave that node both uninformed AND
   * still served, which is much the worse of the two failures.
   */
  readonly closeAfterWrite?: ClusterLinkRefuseReason;
}

/** Either shape is a legal `onFrame` return — see `ClusterFrameReplies`. */
export type ClusterFrameReply = readonly ClusterDownlinkFrame[] | ClusterFrameReplies;

/** The verdict, mirroring `server/ws.ts`'s `WsUpgradeVerdict` in shape so the two guards read the
 *  same way — and deliberately NOT sharing its type, because admitting one is not admitting the
 *  other. */
export type ClusterUpgradeVerdict =
  | { ok: false; reason: ClusterLinkRefuseReason }
  | { ok: true; nodeId: ClusterNodeId };

/** The minimal server surface, satisfied by the `http.Server` `@hono/node-server`'s `serve()`
 *  returns — the same interface `server/ws.ts` declares, for the same reason. */
export interface UpgradeCapableServer {
  on(
    event: 'upgrade',
    listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): unknown;
  on(event: 'close', listener: () => void): unknown;
}

function headerValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** How long `sweepRevoked` will wait for one node's credential re-check before giving up on it for
 *  this tick. Generous: the bound exists to stop a hang, not to police a slow store. */
const DEFAULT_SECRET_LOOKUP_TIMEOUT_MS = 5_000;

/** `CEZ_CLUSTER_SECRET_LOOKUP_TIMEOUT_MS` — an env var, not a config file, per this workspace's
 *  convention, and the same shape as `peers.ts`'s `CEZ_CLUSTER_GIT_TIMEOUT_MS`. Anything unparseable
 *  or non-positive falls back to the default: the one thing this must never do is read as
 *  "disabled", because an unbounded re-check is the defect the bound exists to close. */
function secretLookupTimeoutMs(): number {
  const raw = process.env.CEZ_CLUSTER_SECRET_LOOKUP_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SECRET_LOOKUP_TIMEOUT_MS;
}

/** Distinguishable from a real `undefined` (no stored secret — which IS revocation) and from a
 *  rejection. Returned rather than thrown so each caller keeps its own policy. */
const LOOKUP_TIMED_OUT = Symbol('cluster-link-secret-lookup-timed-out');

/**
 * `lookupSecret` is an INJECTABLE seam (`ClusterLinkServerOptions#lookupSecret`), and a promise that
 * never SETTLES is a different failure from one that rejects: a rejection runs the caller's `catch`
 * and its `finally`; a non-settlement runs neither. `sweepRevoked` guards re-entry with
 * `sweepInFlight`, reset in a `finally` — so a lookup that hangs latches that flag `true` **forever**
 * and every later sweep returns at the guard. The consequence is not a slow sweep: it is that
 * revocation silently stops working for the whole cluster, with no warning, because the only warn on
 * that path fires in the `catch` a hang never reaches.
 *
 * **Latent, not live — stated so nobody records this as a shipped defect.** Production's own lookup
 * (`node-secrets.ts#lookupNodeSecret`) indexes a SYNCHRONOUS read, so it cannot hang; a sync read on
 * a stalled mount blocks the event loop instead, which is worse but immediately visible and cannot
 * latch a flag it never yields to. This bounds the SEAM, for any consumer that injects an
 * async/network-backed lookup.
 */
async function lookupSecretBounded(
  lookup: (nodeId: ClusterNodeId) => Promise<string | undefined>,
  nodeId: ClusterNodeId,
  timeoutMs: number = secretLookupTimeoutMs(),
): Promise<string | undefined | typeof LOOKUP_TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<typeof LOOKUP_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(LOOKUP_TIMED_OUT), timeoutMs);
    // A CLI or a shutting-down server must be able to exit with a re-check outstanding.
    timer.unref?.();
  });
  try {
    // A REJECTION still propagates, deliberately: the caller's existing catch is the right policy
    // for "the store answered, with an error". Only non-settlement is converted.
    return await Promise.race([lookup(nodeId), bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Verifies the signed, freshness-bounded principal on the upgrade request against the enrolled
 *  node's secret. Never consults the Origin header: a node has no origin, and a browser must not be
 *  able to reach this path at all.
 *
 *  **NOT bounded, deliberately — see `lookupSecretBounded`.** A hanging `lookupSecret` here holds one
 *  socket upgrade open indefinitely, which is a bounded blast radius (one client, which times out on
 *  its own side) and not the cluster-wide latch the sweep has. Bounding it would need a refuse reason
 *  meaning "the secret store did not answer", and the honest options are all bad: `unknown-node` says
 *  something false about the node, and a new `ClusterLinkRefuseReason` member is a contract change
 *  that reddens the exhaustive reason gates. Flagged rather than mislabelled. */
export async function authenticateLinkUpgrade(
  req: IncomingMessage,
  lookupSecret: (nodeId: ClusterNodeId) => Promise<string | undefined>,
  options?: { now?: () => Date; maxAgeMs?: number },
): Promise<ClusterUpgradeVerdict> {
  try {
    const claimedNodeId = headerValue(req.headers, CLUSTER_LINK_NODE_HEADER);
    const principal = headerValue(req.headers, CLUSTER_LINK_PRINCIPAL_HEADER);
    const signature = headerValue(req.headers, CLUSTER_LINK_SIGNATURE_HEADER);
    if (!claimedNodeId || !principal || !signature) return { ok: false, reason: 'bad-signature' };

    const secret = await lookupSecret(claimedNodeId);
    if (!secret) return { ok: false, reason: 'unknown-node' };

    const now = options?.now ?? (() => new Date());
    const maxAgeMs = options?.maxAgeMs ?? LINK_PRINCIPAL_MAX_AGE_MS;
    const signed: SignedClusterFrame = { principal, signature };

    const verified = verifyClusterFrame(signed, secret, { now, maxAgeMs });
    if (verified) {
      // Defense in depth: the unsigned lookup header must agree with the SIGNED payload it was
      // used to pick a secret for. It can only disagree if the caller mixed headers from two
      // different nodes, which is not a legitimate client shape either way.
      if (verified.nodeId !== claimedNodeId) return { ok: false, reason: 'bad-signature' };
      return { ok: true, nodeId: verified.nodeId };
    }

    // `verifyClusterFrame` returns null for every failure alike, and an operator has to be able
    // to tell "correctly signed, just old" from "wrong secret / tampered" (D17) — a reconnecting
    // spoke with a slow clock is routine; a bad signature is not. Re-checking with an
    // effectively unbounded window isolates the signature check from the freshness check.
    const withoutAgeBound = verifyClusterFrame(signed, secret, { now, maxAgeMs: Number.MAX_SAFE_INTEGER });
    if (withoutAgeBound && withoutAgeBound.nodeId === claimedNodeId) {
      return { ok: false, reason: 'stale-principal' };
    }
    return { ok: false, reason: 'bad-signature' };
  } catch {
    return { ok: false, reason: 'internal' };
  }
}

export interface ClusterLinkServerOptions {
  /** The hub's own identity — `hubNodeId` on every `welcome`. */
  identity: StoredClusterNodeIdentity;
  /** D22: resolves a claimed node id to its enrollment secret. Optional — defaults to
   *  `cluster/node-secrets.ts#lookupNodeSecret`, the real hub-side store (reading `process.env`,
   *  since this class carries no separate `env` option of its own), so whoever attaches this
   *  server without overriding `lookupSecret` still gets a working link the moment a node has
   *  enrolled. Every current caller supplies this explicitly anyway (see `link-server.test.ts`),
   *  which is what keeps a fake store from ever having to touch the filesystem. */
  lookupSecret?: (nodeId: ClusterNodeId) => Promise<string | undefined>;
  /** Called for every admitted uplink frame, already parsed and bounds-checked. Its return value is
   *  the frame (or frames) to send back, so routing is a pure function of (node, frame) and the
   *  socket bookkeeping stays in this file. Return a bare array, or a `ClusterFrameReplies` when the
   *  router needs to know which of those frames actually reached the socket (D28). */
  onFrame: (nodeId: ClusterNodeId, frame: ClusterUplinkFrame) => Promise<ClusterFrameReply>;
  now?: () => Date;
  warn?: (message: string) => void;
  /** Test seam, same role as `now`: the reap cadence and the D40a hello deadline, defaulting to
   *  `HEARTBEAT_MS` and `HELLO_DEADLINE_MS`. A wedged link is by definition one that takes a long
   *  time to declare itself, so without these a test either waits half a minute or asserts nothing
   *  about the mechanism that actually runs in production. `link-server.test.ts` pins the defaults
   *  so shrinking them here cannot pass unnoticed as a test convenience. */
  heartbeatMs?: number;
  helloDeadlineMs?: number;
}

interface ConnectedNode {
  nodeId: ClusterNodeId;
  ws: WebSocket;
  alive: boolean;
  budgetWindowStart: number;
  budgetUsed: number;
  /** D30 (F3), root cause 1. Set the moment a `hello`-typed frame from this node reaches `onMessage`
   *  — not once the router's reply is inspected, see `connectedNodes()`'s own doc for why "attempted"
   *  is the right, robust signal rather than "welcomed". Starts false: a socket that has only just
   *  finished its upgrade has told the hub nothing yet, in particular not the watermark this hub
   *  should trust for it, and must not be handed to `planReplicaFanout` as a target until it has. */
  helloReceived: boolean;
  /** When this socket finished its upgrade, for `HELLO_DEADLINE_MS`. Not `alive`'s business: a node
   *  that answers pings while never sending a usable frame is exactly the wedge (D40a), so liveness
   *  and usefulness have to be tracked separately or the heartbeat certifies the fault as health. */
  connectedAt: number;
}

export class ClusterLinkServer {
  private readonly wss: WebSocketServer;
  private readonly nodes = new Map<ClusterNodeId, ConnectedNode>();
  private readonly lookupSecret: (nodeId: ClusterNodeId) => Promise<string | undefined>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;
  /** D48. `sweepRevoked` is async and driven by an interval, so a slow secret store could otherwise
   *  stack overlapping sweeps, each walking a map the others are mutating. One at a time; a tick
   *  that arrives while a sweep is running is dropped, not queued — the next one re-reads
   *  everything anyway. */
  private sweepInFlight = false;

  constructor(private readonly options: ClusterLinkServerOptions) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: CLUSTER_FRAME_MAX_BYTES });
    this.wss.on('connection', (ws: WebSocket, _req: IncomingMessage, nodeId: ClusterNodeId) => {
      this.onConnection(ws, nodeId);
    });
    // Resolved once, here — see `ClusterLinkServerOptions#lookupSecret`'s own doc (D22).
    this.lookupSecret = options.lookupSecret ?? ((nodeId) => lookupNodeSecret(nodeId));
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private onConnection(ws: WebSocket, nodeId: ClusterNodeId): void {
    // A reconnect from the same node replaces the old socket outright — one link per node, so a
    // stale half-open handle from a prior connection never lingers in `this.nodes`.
    const existing = this.nodes.get(nodeId);
    if (existing) {
      try {
        existing.ws.terminate();
      } catch {
        // Already gone.
      }
    }
    const node: ConnectedNode = {
      nodeId,
      ws,
      alive: true,
      budgetWindowStart: this.now().getTime(),
      budgetUsed: 0,
      helloReceived: false,
      connectedAt: this.now().getTime(),
    };
    this.nodes.set(nodeId, node);

    ws.on('pong', () => {
      node.alive = true;
    });
    ws.on('message', (raw) => {
      void this.onMessage(node, raw);
    });
    ws.on('close', () => {
      if (this.nodes.get(nodeId) === node) this.nodes.delete(nodeId);
    });
    // A socket error is followed by 'close'; this handler exists only so `ws` never throws it as
    // an unhandled 'error' event — matching `server/ws.ts`'s own reasoning verbatim.
    ws.on('error', () => undefined);
  }

  private async onMessage(node: ConnectedNode, raw: unknown): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      this.options.warn?.(`cluster link: malformed frame from ${node.nodeId} (not JSON)`);
      return;
    }
    const result = clusterUplinkFrameSchema.safeParse(parsed);
    if (!result.success) {
      // D13's per-entry-salvage spirit at the frame level: one bad frame is dropped and logged,
      // never a reason to tear down an otherwise-good link. There is no generic "error" downlink
      // frame in this protocol (unlike the cockpit bus), so a frame this file cannot even parse has
      // nowhere to state itself on the wire and is warned about locally instead.
      //
      // **CORRECTED 2026-08-23 — this used to read "`refuse` is reserved for the two named,
      // link-ending reasons below", which was wrong twice over and in the direction that misleads.**
      // `clusterLinkRefuseReasonSchema` (`contract/src/cluster.ts`) has EIGHT members —
      // `protocol-major`, `unknown-node`, `bad-signature`, `stale-principal`, `node-disabled`,
      // `frame-too-large`, `handshake-timeout`, `internal` — and only the first is raised "below" in
      // this function; the rest come from the upgrade guard, `reap()`, and `hub-router.ts`.
      //
      // **CORRECTED again 2026-08-23, same day (D48) — `node-disabled` did NOT come from
      // "`peers.ts`'s revoke", as this list claimed; it came from nowhere at all.** Measured:
      // `grep -a node-disabled` over the whole workspace found the contract's enum member, this
      // sentence, and one line of `link-server.test.ts` — no production emitter existed. The
      // attribution was not a documentation slip but a description of the D48 hole: `disableNode`
      // deletes the node's secret and never touches its live socket, so nothing ever raised the one
      // reason named for revocation. `reap()` -> `sweepRevoked` is the emitter now, and the entry
      // above is corrected to say so. Nor is every
      // refusal link-ending in the same way: what IS reserved to exactly one reason lives at the
      // OTHER end, where `link-client.ts` sets `suppressReconnect` for `protocol-major` alone, so
      // every other reason is retried. Read that as the real decision surface, not this list.
      this.options.warn?.(`cluster link: invalid frame from ${node.nodeId}: ${result.error.message}`);
      return;
    }
    const frame = result.data;

    // Every frame carries `protocol`, not just `hello` — a link resumes far more often than it is
    // established (the hub blue-green deploys ~10×/day), so any frame able to state its version can
    // be checked. A partial apply that looks complete is the worse failure (D13).
    if (frame.protocol.major !== CLUSTER_PROTOCOL_MAJOR) {
      this.refuse(node.nodeId, 'protocol-major');
      return;
    }

    // D30 (F3), root cause 1. Deliberately keyed on the INCOMING frame's type, not on what `onFrame`
    // replies — checking the reply (e.g. "only if it welcomed") would make `connectedNodes()`'s
    // behaviour depend on `hub-router.ts`'s internal verdict, which this file has no business
    // inspecting (its own module doc: "it has no opinion on what any frame MEANS").
    //
    // **CORRECTED 2026-08-23, same day (D40b) — the paragraph that stood here was WRONG, and it was
    // wrong about the exact safety property this line exists to hold.** Original text: ~~"A `hello`
    // whose CLAIMED nodeId disagrees with the authenticated one is refused by `hub-router.ts` with a
    // `refuse` reply, not disconnected — that is a pre-existing, separate gap … and not this fix's
    // concern: it does not reopen D30's race, because a socket that has attempted ANY hello has
    // already run `seedWatermark` for this authenticated nodeId synchronously."~~ It has not. That
    // guard returns from `hub-router.ts`'s `hello` case BEFORE the `watermarks.delete(nodeId)` and
    // the `seedWatermark` loop that follow it, so a forged `hello` set this flag and reseeded
    // nothing: the node became a `connectedNodes()` fan-out target carrying whatever stale watermark
    // a previous session left behind — D30 root cause 1 verbatim, reopened by the one frame that
    // most deserves not to be trusted. Measured by retransmit: after a forged hello an op below the
    // stale mark was NOT re-sent; after a legitimate one it was.
    //
    // The flag is still set here, unconditionally and on the frame TYPE, because the alternative is
    // the layering violation named above. What changed is that the router can now END the link it
    // has refused, via `ClusterFrameReplies#closeAfterWrite` — so the node is removed from
    // `this.nodes` in this same call, right after its `refuse` is written, and is a fan-out target
    // for no turn of the event loop in between (the guard replies without awaiting, so the `await`
    // below spans microtasks only, and another socket's 'message' callback is a macrotask).
    if (frame.type === 'hello') node.helloReceived = true;

    let replies: ClusterFrameReply;
    try {
      replies = await this.options.onFrame(node.nodeId, frame);
    } catch (err) {
      this.options.warn?.(
        `cluster link: onFrame threw for ${node.nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const frames = Array.isArray(replies) ? replies : (replies as ClusterFrameReplies).frames;
    const onWritten = Array.isArray(replies) ? undefined : (replies as ClusterFrameReplies).onWritten;
    const closeAfterWrite = Array.isArray(replies) ? undefined : (replies as ClusterFrameReplies).closeAfterWrite;

    // D28 (F4) — THE OTHER HALF of the fix. `writeFrame`'s return value used to be discarded
    // outright here, which is exactly what let the hub believe a reply had gone out when it had not:
    // `writeFrame` itself already warns for every failure reason (oversized, send-budget exhausted,
    // socket no longer open — see its own doc), and `onWritten` reports the same boolean back to the
    // router so a watermark is advanced only for a frame that actually reached the socket.
    //
    // **CORRECTED 2026-08-23, same day: this loop now STOPS on ANY undelivered frame, not only on a
    // closed socket.** The earlier version continued past an oversized or budget-exhausted frame, on
    // the reasoning that only a dead socket dooms the rest of the batch. That is true of the SOCKET
    // and false of the CONTENT: a reply batch is `[ack, replica(hubSeq 5), replica(hubSeq 9)]`, and
    // the receiver's `appliedThroughHubSeq` is monotonic (`cluster/replica.ts` skips anything at or
    // below it). Dropping hubSeq 5 and then writing hubSeq 9 makes the receiver advance to 9 and
    // discard 5 forever if it ever arrives — a silent gap manufactured by the WRITER, out of a frame
    // that was merely delayed. Stopping instead leaves both unadvanced at the hub, so both are owed
    // again on the next batch: a retransmit, which is the cheap direction, rather than a gap, which
    // is the expensive one. (The budget case makes every remaining write fail anyway; the oversize
    // case is the one this genuinely changes, and it is also the one that reorders.)
    let stopped = false;
    for (const reply of frames) {
      // Every frame gets a verdict, including the ones never attempted. "Not reported" and
      // "delivered" must not be the same observation at the router — that IS the bug, one level up.
      if (stopped) {
        onWritten?.(reply, false);
        continue;
      }
      const delivered = this.writeFrame(node, reply);
      onWritten?.(reply, delivered);
      if (!delivered) stopped = true;
    }

    // D40b — the router asked for the link to END, not merely to be answered. Deliberately after the
    // write loop (the spoke gets its stated reason) and deliberately NOT conditional on `stopped`:
    // see `ClusterFrameReplies#closeAfterWrite` for why an undelivered refusal must still cut the
    // node off rather than leaving it uninformed and still served.
    if (closeAfterWrite !== undefined) this.closeNode(node, closeAfterWrite);
  }

  private consumeBudget(node: ConnectedNode): boolean {
    const t = this.now().getTime();
    if (t - node.budgetWindowStart >= SEND_BUDGET_TICK_MS) {
      node.budgetWindowStart = t;
      node.budgetUsed = 0;
    }
    if (node.budgetUsed >= SEND_BUDGET_FRAMES_PER_TICK) return false;
    node.budgetUsed += 1;
    return true;
  }

  /**
   * D28 (F4) / D13: every failure path here now states its reason (`this.options.warn?.`) rather
   * than only the oversized one, which is what this file's own module doc (`:34`, "A refusal is a
   * stated reason, never a silent drop") already claimed and the send-budget path did not honour.
   * Centralised HERE, in the one place that decides "delivered or not", rather than in each of
   * `writeFrame`'s three callers (`onMessage`'s reply loop, `send`, `refuse`) individually — a
   * caller that forgets to check the boolean still gets the loud signal for free, which is exactly
   * the property `onMessage`'s own D28 bug proves cannot be assumed of every caller by convention
   * alone.
   */
  private writeFrame(node: ConnectedNode, frame: ClusterDownlinkFrame): boolean {
    if (node.ws.readyState !== 1 /* OPEN */) {
      // Routine, not alarming: the async gap between a node's disconnect and this write attempt is
      // a normal race (see `onConnection`'s 'close' handler), not a bug — still stated, not silent.
      this.options.warn?.(`cluster link: cannot deliver ${frame.type} to ${node.nodeId} — socket is not open, dropped`);
      return false;
    }
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, 'utf8') > CLUSTER_FRAME_MAX_BYTES) {
      this.options.warn?.(`cluster link: outgoing ${frame.type} frame to ${node.nodeId} exceeds the frame bound, dropped`);
      return false;
    }
    if (!this.consumeBudget(node)) {
      this.options.warn?.(
        `cluster link: send budget exhausted for ${node.nodeId} (${SEND_BUDGET_FRAMES_PER_TICK}/${SEND_BUDGET_TICK_MS}ms) — ` +
          `outgoing ${frame.type} frame dropped, not queued; the sender's own retry (outbox resend, next hello) is what recovers it`,
      );
      return false;
    }
    node.ws.send(encoded);
    return true;
  }

  /** Start accepting `CLUSTER_LINK_PATH` upgrades. Boot-time wiring: attaching twice throws.
   *
   *  **Coexistence note for whoever wires this beside `server/ws.ts`'s socket hub on the same
   *  `http.Server`** (package 1.5's activation step): this listener only ACTS on
   *  `CLUSTER_LINK_PATH` and does nothing for any other path — it never calls `socket.destroy()`
   *  for a path it does not own, unlike `server/ws.ts#attach`, which destroys every upgrade whose
   *  path is not `WS_PATH`. Node calls every registered `'upgrade'` listener for a single event
   *  (there is no `stopPropagation`), so if the cockpit hub's listener is registered FIRST it will
   *  destroy a `CLUSTER_LINK_PATH` request before this listener ever runs. That ordering hazard is
   *  in `server/ws.ts`, which this package does not own — flagged here, not fixed here. */
  attach(server: UpgradeCapableServer): void {
    if (this.heartbeat !== undefined) throw new Error('cluster link server already attached');
    server.on('upgrade', (req, socket, head) => {
      const pathname = new URL(req.url ?? '', 'http://localhost').pathname;
      if (pathname !== CLUSTER_LINK_PATH) return; // not ours — leave it for another listener
      void this.handleUpgrade(req, socket, head);
    });
    server.on('close', () => {
      void this.close();
    });
    this.heartbeat = setInterval(() => this.reap(), this.options.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const verdict = await authenticateLinkUpgrade(req, this.lookupSecret, { now: () => this.now() });
    if (!verdict.ok) {
      try {
        if (socket.writable) {
          socket.write(
            `HTTP/1.1 401 Unauthorized\r\n${CLUSTER_LINK_REFUSE_REASON_HEADER}: ${verdict.reason}\r\nconnection: close\r\n\r\n`,
          );
        }
      } catch {
        // Socket may already be gone.
      }
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req, verdict.nodeId);
    });
  }

  /** `false` when that node is not currently linked. The hub never queues a downlink frame for an
   *  absent node: the spoke resumes from watermarks on reconnect, so buffering here would be a
   *  second, worse copy of a mechanism that already exists. */
  send(nodeId: ClusterNodeId, frame: ClusterDownlinkFrame): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    return this.writeFrame(node, frame);
  }

  /**
   * Every node with a live socket right now AND that has attempted a `hello` on THIS connection.
   * Presence-derived liveness lives on the peer record; this is the transport's own, narrower
   * answer: "can this hub usefully hand this node a fan-out target right now".
   *
   * **D30 (F3), root cause 1, fixed 2026-08-23.** Used to be `[...this.nodes.keys()]` — every node
   * from the moment `onConnection` runs, before it had said anything at all. That let a socket that
   * had JUST finished its upgrade, and had not yet told the hub its own applied position, be handed
   * to `planReplicaFanout` as a target: `hub-router.ts`'s watermark entry for it, if it had one at
   * all, was either absent (read as 0 — harmless) or STALE from a previous session (read as
   * whatever it was, which a hub restart never resets and a disconnect never clears) — and since a
   * spoke's own applied position resets to 0 on its OWN restart, "stale and too high" was the
   * likely case, not the exotic one. A too-high watermark is a silent, permanent gap: the hub
   * believes the node holds ops it was never sent, and only that node's own EVENTUAL `hello` (a SET,
   * not a max — see `hub-router.ts`'s `seedWatermark`) would ever correct it.
   *
   * Gating on `helloReceived` closes this structurally, not by timing luck: `onMessage` flips that
   * flag SYNCHRONOUSLY, in the same call stack that invokes `onFrame`, and `hub-router.ts`'s `hello`
   * case runs `seedWatermark` — also synchronously, before its own first `await` — as the very
   * first thing it does. So there is no turn of the event loop in which this node can be exposed
   * here with a watermark that has not just been correctly, truthfully re-seeded.
   */
  connectedNodes(): ClusterNodeId[] {
    return [...this.nodes.values()].filter((node) => node.helloReceived).map((node) => node.nodeId);
  }

  /** Refuse and close, with the reason on the wire so the spoke can render it rather than showing a
   *  bare disconnect. A no-op for a node that is not currently connected. */
  refuse(nodeId: ClusterNodeId, reason: ClusterLinkRefuseReason, message?: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.refuseNode(node, reason, message);
  }

  /** `refuse` by IDENTITY rather than by id, for callers holding a `ConnectedNode` they read at
   *  some earlier point — `sweepRevoked`, whose `await` gives a reconnect room to replace the map
   *  entry in between. Refusing by id there could write a `node-disabled` frame onto, and close, a
   *  freshly re-enrolled node's legitimate socket on behalf of the revoked one it replaced. Same
   *  hazard `closeNode`'s own identity guard exists for, one step earlier. */
  private refuseNode(node: ConnectedNode, reason: ClusterLinkRefuseReason, message?: string): void {
    this.writeFrame(node, { type: 'refuse', protocol: CLUSTER_PROTOCOL, reason, message });
    this.closeNode(node, reason);
  }

  /**
   * **D48, 2026-08-23 — revoking a node now ends the link it ALREADY has.** Until this, revocation
   * moved exactly one thing: `peers.ts#disableNode` stamped `disabledAt` and deleted the node's
   * stored secret. That makes `authenticateLinkUpgrade` refuse the node's NEXT dial with
   * `unknown-node` — and does nothing whatsoever to the socket it is holding right now. A link
   * authenticates ONCE, at upgrade; no frame on an established socket carries a signature, and
   * nothing re-read the credential afterwards. So a revoked node kept its live link and kept being
   * served indefinitely: it stayed in `connectedNodes()` (hence a replica fan-out target), its
   * `ops` frames kept being applied, and the only thing that would ever have cut it was the node
   * choosing to disconnect. The revoke reported success the whole time.
   *
   * `hub-router.ts` declines to gate its `hello` handler on `disabledAt`, and says why: the upgrade
   * guard "already refuses the UPGRADE before a socket exists to carry a `hello` on". That is true
   * of a NEW connection and false of a live one, and it is the same conflation this sweep closes —
   * "cannot authenticate again" and "is not authenticated now" are different claims.
   *
   * **Deliberately a PULL, not a push from the revoking code.** A push (`disableNode` calling
   * `refuse`) cannot work for the primary revoke path at all: `cez cluster revoke <nodeId>` runs in
   * a separate CLI process, where no `ClusterLinkServer` exists and the live socket belongs to the
   * hub server process. It would also be conditional on every present and future revoke path
   * remembering to make the call — exactly the shape that produced `disableNode`'s own earlier
   * `if (found)` hole. Re-reading the credential is unconditional by construction: whatever removed
   * the secret, by whatever path and in whatever process, the link goes.
   *
   * **The window is bounded by the reap cadence** (`heartbeatMs`, `HEARTBEAT_MS` = 30s in
   * production), not closed instantly — a revoked node may be served for up to one tick. Stated
   * rather than hidden: an in-process caller that needs the cut to be immediate can call
   * `refuse(nodeId, 'node-disabled')` directly, and this sweep remains the backstop that holds when
   * nobody does.
   *
   * **A lookup that THROWS is not evidence of revocation**, and is skipped rather than treated as
   * one. Cutting every link because the secret store was briefly unreadable would convert one bad
   * read into a cluster-wide outage that could not heal — the upgrade path reads the same store, so
   * nothing could reconnect either. A store that reads fine and simply has no entry is a different
   * thing and IS revocation: `lookupNodeSecret` degrades a missing file to `undefined` on purpose,
   * and "no secrets are stored" correctly means nothing may be linked.
   */
  private async sweepRevoked(): Promise<void> {
    if (this.sweepInFlight || this.closed) return;
    this.sweepInFlight = true;
    try {
      // Snapshot before awaiting: the map is mutated by reconnects, by 'close' handlers and by the
      // refusals below, and walking it live across an `await` is how the wrong socket gets cut.
      for (const node of [...this.nodes.values()]) {
        let secret: string | undefined;
        try {
          const looked = await lookupSecretBounded((id) => this.lookupSecret(id), node.nodeId);
          if (looked === LOOKUP_TIMED_OUT) {
            // Same policy as a throw below — leave the link up and retry — because "the store did
            // not answer" is not evidence of revocation. The difference that matters is that this
            // branch RETURNS, so the `finally` runs and `sweepInFlight` is released.
            this.options.warn?.(
              `cluster link: re-checking ${node.nodeId}'s credential did not answer within ` +
                `${secretLookupTimeoutMs()}ms, leaving the link up and retrying next sweep`,
            );
            continue;
          }
          secret = looked;
        } catch (err) {
          this.options.warn?.(
            `cluster link: could not re-check ${node.nodeId}'s credential, leaving the link up and retrying next sweep: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }
        if (secret !== undefined) continue;
        if (this.closed) return;
        // Identity, not id — see `refuseNode`. A node re-enrolled during the await above holds a
        // DIFFERENT `ConnectedNode` here, and its new link is none of this sweep's business.
        if (this.nodes.get(node.nodeId) !== node) continue;
        this.options.warn?.(
          `cluster link: ${node.nodeId} has no stored secret any more — it was revoked while linked; ` +
            'refusing with node-disabled so the live socket cannot outlive the credential that opened it',
        );
        this.refuseNode(node, 'node-disabled', 'this node was revoked on the hub');
      }
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * End a link that has ALREADY been told why: close the socket with `reason` as the RFC 6455 close
   * reason (1008, Policy Violation) and drop the node from the roster. Writes nothing — the two
   * callers (`refuse`, and `onMessage`'s `closeAfterWrite`) each put their own frame on the wire
   * first, and a second, unrequested `refuse` would be a frame the router never returned.
   *
   * The removal is guarded on identity, not just on the id, matching `onConnection`'s 'close'
   * handler: a reconnect from the same node REPLACES the entry in `this.nodes` (`onConnection`
   * terminates the old socket and overwrites the map), so deleting by id alone could evict a live,
   * newer link on behalf of the dead one it replaced.
   */
  private closeNode(node: ConnectedNode, reason: ClusterLinkRefuseReason): void {
    try {
      node.ws.close(1008, reason);
    } catch {
      // Already gone.
    }
    if (this.nodes.get(node.nodeId) === node) this.nodes.delete(node.nodeId);
  }

  private reap(): void {
    // D48 — re-check every live link's credential on this same tick. Fire-and-forget on purpose:
    // `reap` is a synchronous interval callback and the liveness work below must not wait on a
    // filesystem read. `sweepRevoked` never rejects (it catches per node), so there is no floating
    // rejection here; `sweepInFlight` keeps ticks from stacking.
    void this.sweepRevoked();

    // D40a — collected before acting, because `refuse` deletes from the map this loop is walking.
    const t = this.now().getTime();
    const wedged = [...this.nodes.values()].filter(
      (node) => !node.helloReceived && t - node.connectedAt >= (this.options.helloDeadlineMs ?? HELLO_DEADLINE_MS),
    );
    for (const node of wedged) {
      this.options.warn?.(
        `cluster link: ${node.nodeId} upgraded ${Math.round((t - node.connectedAt) / 1_000)}s ago and has sent no usable frame — ` +
          'refusing with handshake-timeout so the spoke retries instead of sitting in "connecting" forever',
      );
      // `refuse`, not a bare close: the whole point is that the spoke can render a cause and its
      // backoff can climb. `handshake-timeout` is an ordinary RETRIED reason — `link-client.ts`
      // suppresses reconnection for `protocol-major` alone — so a link wedged by a transient fault
      // heals itself, which a bare `terminate()` (what `alive` does below) would not communicate.
      this.refuse(node.nodeId, 'handshake-timeout');
    }

    for (const node of this.nodes.values()) {
      if (!node.alive) {
        try {
          node.ws.terminate();
        } catch {
          // Already gone; 'close' will still fire and clean up `this.nodes`.
        }
        continue;
      }
      node.alive = false;
      try {
        node.ws.ping();
      } catch {
        // Already gone.
      }
    }
  }

  /** Idempotent; also runs on the attached server's own `close`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const node of this.nodes.values()) {
      try {
        node.ws.terminate();
      } catch {
        // Already gone.
      }
    }
    this.nodes.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
