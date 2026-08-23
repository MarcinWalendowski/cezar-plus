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
const HEARTBEAT_MS = 30_000;

/** Per-node send budget: a spoke offline for hours, or a hub with a large backlog to push down,
 *  must not be able to starve every OTHER node sharing this process's event loop and bandwidth. */
export const SEND_BUDGET_FRAMES_PER_TICK = 100;
export const SEND_BUDGET_TICK_MS = 1_000;

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

/** Verifies the signed, freshness-bounded principal on the upgrade request against the enrolled
 *  node's secret. Never consults the Origin header: a node has no origin, and a browser must not be
 *  able to reach this path at all. */
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
   *  socket bookkeeping stays in this file. */
  onFrame: (nodeId: ClusterNodeId, frame: ClusterUplinkFrame) => Promise<ClusterDownlinkFrame[]>;
  now?: () => Date;
  warn?: (message: string) => void;
}

interface ConnectedNode {
  nodeId: ClusterNodeId;
  ws: WebSocket;
  alive: boolean;
  budgetWindowStart: number;
  budgetUsed: number;
}

export class ClusterLinkServer {
  private readonly wss: WebSocketServer;
  private readonly nodes = new Map<ClusterNodeId, ConnectedNode>();
  private readonly lookupSecret: (nodeId: ClusterNodeId) => Promise<string | undefined>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private closed = false;

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
      // frame in this protocol (unlike the cockpit bus) — `refuse` is reserved for the two named,
      // link-ending reasons below.
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

    let replies: ClusterDownlinkFrame[];
    try {
      replies = await this.options.onFrame(node.nodeId, frame);
    } catch (err) {
      this.options.warn?.(
        `cluster link: onFrame threw for ${node.nodeId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const reply of replies) this.writeFrame(node, reply);
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

  private writeFrame(node: ConnectedNode, frame: ClusterDownlinkFrame): boolean {
    if (node.ws.readyState !== 1 /* OPEN */) return false;
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, 'utf8') > CLUSTER_FRAME_MAX_BYTES) {
      this.options.warn?.(`cluster link: outgoing ${frame.type} frame to ${node.nodeId} exceeds the frame bound, dropped`);
      return false;
    }
    if (!this.consumeBudget(node)) return false;
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
    this.heartbeat = setInterval(() => this.reap(), HEARTBEAT_MS);
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

  /** Every node with a live socket right now. Presence-derived liveness lives on the peer record;
   *  this is the transport's own answer. */
  connectedNodes(): ClusterNodeId[] {
    return [...this.nodes.keys()];
  }

  /** Refuse and close, with the reason on the wire so the spoke can render it rather than showing a
   *  bare disconnect. A no-op for a node that is not currently connected. */
  refuse(nodeId: ClusterNodeId, reason: ClusterLinkRefuseReason, message?: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) return;
    this.writeFrame(node, { type: 'refuse', protocol: CLUSTER_PROTOCOL, reason, message });
    try {
      node.ws.close(1008, reason); // RFC 6455 Policy Violation
    } catch {
      // Already gone.
    }
    this.nodes.delete(nodeId);
  }

  private reap(): void {
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
