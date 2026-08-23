import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_LINK_PATH,
  CLUSTER_PROTOCOL,
  clusterDownlinkFrameSchema,
  type ClusterDownlinkFrame,
  type ClusterLinkHealth,
  type ClusterLinkRefuseReason,
  type ClusterUplinkFrame,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { signClusterFrame } from './enrollment.ts';
import {
  CLUSTER_LINK_NODE_HEADER,
  CLUSTER_LINK_PRINCIPAL_HEADER,
  CLUSTER_LINK_REFUSE_REASON_HEADER,
  CLUSTER_LINK_SIGNATURE_HEADER,
} from './link-server.ts';

/**
 * The spoke end of the link: one outbound WebSocket to the hub, `hello`/`welcome`, resume from
 * watermarks, reconnect with backoff (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D13 · D15 · D15b · D16).
 *
 * **Outbound only. Nothing ever listens on a spoke** — the Mac has no inbound address, and not
 * needing one is a security property, not a workaround.
 *
 * **A disconnected link is an ordinary cezar cockpit, not a degraded one** (D15). Nothing blocks on
 * this class: not a todo write, not a run a person starts by hand. It queues ops and reconnects.
 * The one thing that waits for the hub is a claim on a REPLICATED todo (D9a/D15a), and that refusal
 * is a stated, rendered state — never a silent skip.
 *
 * **Reconnection is the normal case, not the exception** (D15b). The hub blue-green self-deploys
 * ~10 times a day at ~5 s of outage each, so this reconnects with exponential backoff and **full
 * jitter** (`sources/sync.ts`'s own shape), re-asserts the leases it still holds, and resumes from
 * watermarks rather than replaying from zero.
 *
 * **Phase 1 is inert — no state replicates yet** (spec Phases → "Phase 1"), so the `hello` this
 * class sends carries empty `watermarks`/`projects`: there is nothing to resume or advertise until a
 * later phase's reconcile/pairing machinery exists to feed it. `send()` is how that content reaches
 * the wire once it does — this class stays a thin, honest transport rather than guessing.
 *
 * Events emitted (`EventEmitter`, the shape `RunStore` already uses):
 *  - `frame` — `(frame: ClusterDownlinkFrame)`, already parsed and protocol-checked;
 *  - `health` — `(health: ClusterLinkHealth)`, on every state transition, so the cockpit's link row
 *    is driven by transitions rather than by polling;
 *  - `refused` — `(health: ClusterLinkHealth)`, when the hub refused with a stated reason. A
 *    `protocol-major` refusal must NOT be retried into a hot loop: it is an upgrade, not an outage.
 */

/** Same cadence as the hub's own per-node budget (`link-server.ts`) — this node must not be able to
 *  monopolise the link with its own backlog either. */
const SEND_BUDGET_FRAMES_PER_TICK = 100;
const SEND_BUDGET_TICK_MS = 1_000;

export interface ClusterLinkClientOptions {
  identity: StoredClusterNodeIdentity;
  hubUrl: string;
  /**
   * This node's own cezar version, carried on `hello` (D13: version skew is permanent, so every
   * frame reports it rather than assuming). Not derivable from `identity` or any other option here
   * — injected the same way `ServerDeps.version` is, by whoever boots this class.
   */
  version: string;
  now?: () => number;
  warn?: (message: string) => void;
  /** Full jitter over an exponential base. Injected so a test can pin it. */
  backoff?: LinkBackoffOptions;
  random?: () => number;
}

export interface LinkBackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_LINK_BACKOFF: LinkBackoffOptions = { baseMs: 1_000, maxMs: 60_000 };

/** Full jitter: `random() * min(maxMs, baseMs * 2**attempt)`. Not equal jitter, not decorrelated —
 *  the same shape `sources/sync.ts` already uses, so the two backoffs in this codebase are one
 *  thing. */
export function nextBackoffMs(
  attempt: number,
  options?: LinkBackoffOptions,
  random?: () => number,
): number {
  const { baseMs, maxMs } = options ?? DEFAULT_LINK_BACKOFF;
  const cap = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const rand = random ?? Math.random;
  return Math.floor(rand() * cap);
}

/** `hubUrl` (`http(s)://…`) to the link's `ws(s)://…` upgrade URL. */
function linkUrl(hubUrl: string): string {
  const url = new URL(hubUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = CLUSTER_LINK_PATH;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class ClusterLinkClient extends EventEmitter {
  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  /** Not yet started, or `stop()`ed — `dial()` refuses to run while this is true. */
  private stopped = true;
  private healthState: ClusterLinkHealth = { state: 'offline' };
  private budgetWindowStart = 0;
  private budgetUsed = 0;

  constructor(private readonly options: ClusterLinkClientOptions) {
    super();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private setHealth(next: ClusterLinkHealth): void {
    this.healthState = next;
    this.emit('health', next);
  }

  /** Idempotent. Dials, and keeps dialling — a hub that is down is a state, not an error. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.dial();
  }

  private dial(): void {
    if (this.stopped) return;
    this.setHealth({ state: 'connecting', since: new Date(this.now()).toISOString() });

    const principal = { nodeId: this.options.identity.nodeId, issuedAt: new Date(this.now()).toISOString() };
    const signed = signClusterFrame(principal, this.options.identity.secret ?? '');

    const ws = new WebSocket(linkUrl(this.options.hubUrl), {
      maxPayload: CLUSTER_FRAME_MAX_BYTES,
      headers: {
        [CLUSTER_LINK_NODE_HEADER]: this.options.identity.nodeId,
        [CLUSTER_LINK_PRINCIPAL_HEADER]: signed.principal,
        [CLUSTER_LINK_SIGNATURE_HEADER]: signed.signature,
      },
    });
    this.ws = ws;

    // Guards `unexpected-response` and `close` both firing for the same failed attempt from
    // scheduling two competing reconnects.
    let settled = false;
    // Set only for a `protocol-major` refusal — an upgrade, not an outage, so it must not be
    // retried into a hot loop (the class's own documented exception).
    let suppressReconnect = false;

    const disconnect = (refusedReason?: ClusterLinkRefuseReason): void => {
      if (settled) return;
      settled = true;
      if (this.ws === ws) this.ws = undefined;
      if (this.stopped || suppressReconnect) return;
      this.scheduleReconnect(refusedReason);
    };

    ws.on('unexpected-response', (_req, res) => {
      const raw = res.headers[CLUSTER_LINK_REFUSE_REASON_HEADER];
      const reason = (Array.isArray(raw) ? raw[0] : raw) as ClusterLinkRefuseReason | undefined;
      this.options.warn?.(
        `cluster link: upgrade refused (${res.statusCode ?? '?'}${reason ? `: ${reason}` : ''})`,
      );
      res.resume(); // drain so the socket can close cleanly
      disconnect(reason);
    });

    ws.on('open', () => {
      this.attempt = 0; // a successful handshake resets the backoff
      this.sendHello(ws);
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return; // a superseded socket's late message
      const frame = this.parseDownlink(raw);
      if (!frame) return;
      const lastFrameAt = new Date(this.now()).toISOString();

      if (frame.type === 'welcome') {
        this.setHealth({ state: 'online', since: this.healthState.since, lastFrameAt });
      } else if (frame.type === 'refuse') {
        this.setHealth({
          state: 'refused',
          since: this.healthState.since,
          lastFrameAt,
          refusedReason: frame.reason,
        });
        this.emit('refused', this.healthState);
        if (frame.reason === 'protocol-major') suppressReconnect = true;
        ws.close();
      } else {
        this.setHealth({ ...this.healthState, lastFrameAt });
      }
      this.emit('frame', frame);
    });

    ws.on('close', () => disconnect());
    // A socket error is followed by 'close'; this handler exists only so `ws` never throws it as
    // an unhandled 'error' event.
    ws.on('error', () => undefined);
  }

  private parseDownlink(raw: WebSocket.RawData): ClusterDownlinkFrame | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      this.options.warn?.('cluster link: malformed frame from hub (not JSON)');
      return undefined;
    }
    const result = clusterDownlinkFrameSchema.safeParse(parsed);
    if (!result.success) {
      this.options.warn?.(`cluster link: invalid frame from hub: ${result.error.message}`);
      return undefined;
    }
    return result.data;
  }

  private scheduleReconnect(refusedReason?: ClusterLinkRefuseReason): void {
    if (this.stopped) return;
    const delayMs = nextBackoffMs(this.attempt, this.options.backoff, this.options.random);
    this.attempt += 1;
    this.setHealth({
      state: 'offline',
      since: this.healthState.since,
      refusedReason,
      retryAt: new Date(this.now() + delayMs).toISOString(),
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.dial();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  /** Closes cleanly and stops the reconnect timer. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    this.setHealth({ state: 'offline', since: this.healthState.since });
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
      try {
        ws.close(1000, 'stopping');
      } catch {
        resolve();
      }
    });
  }

  private consumeSendBudget(): boolean {
    const t = this.now();
    if (t - this.budgetWindowStart >= SEND_BUDGET_TICK_MS) {
      this.budgetWindowStart = t;
      this.budgetUsed = 0;
    }
    if (this.budgetUsed >= SEND_BUDGET_FRAMES_PER_TICK) return false;
    this.budgetUsed += 1;
    return true;
  }

  private writeFrame(ws: WebSocket, frame: ClusterUplinkFrame): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, 'utf8') > CLUSTER_FRAME_MAX_BYTES) {
      this.options.warn?.(`cluster link: outgoing ${frame.type} frame exceeds the frame bound, dropped`);
      return false;
    }
    if (!this.consumeSendBudget()) return false;
    ws.send(encoded);
    return true;
  }

  private sendHello(ws: WebSocket): void {
    const frame: ClusterUplinkFrame = {
      type: 'hello',
      protocol: CLUSTER_PROTOCOL,
      nodeId: this.options.identity.nodeId,
      nodeName: this.options.identity.nodeName,
      version: this.options.version,
      labels: this.options.identity.labels,
      // Phase 1 is inert (see the module doc) — nothing has replicated yet, so there is nothing
      // to resume from or advertise.
      watermarks: [],
      projects: [],
    };
    this.writeFrame(ws, frame);
  }

  /** `false` when the frame was not sent — offline, over `CLUSTER_FRAME_MAX_BYTES`, or past this
   *  tick's send budget. A caller keeps the op; the outbox is derived, so nothing is lost either
   *  way, but a silent drop reported as a send would be. */
  send(frame: ClusterUplinkFrame): boolean {
    if (!this.ws) return false;
    return this.writeFrame(this.ws, frame);
  }

  /** What the cockpit's link row renders, including `lastReconcileAt` — D16's health signal, the
   *  one number that separates "nothing changed" from "nothing is arriving". Not yet set by this
   *  class: the periodic full reconcile that stamps it is Phase 2+ machinery. */
  health(): ClusterLinkHealth {
    return this.healthState;
  }
}
