import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_LINK_PATH,
  CLUSTER_PROTOCOL,
  clusterDownlinkFrameSchema,
  clusterWatermarkSchema,
  type ClusterDownlinkFrame,
  type ClusterLinkHealth,
  type ClusterLinkRefuseReason,
  type ClusterUplinkFrame,
  type ClusterWatermark,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { resolveEdgeAuthHeaders } from './edge-auth.ts';
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
 * **CORRECTED 2026-08-23 (D38) — `watermarks` is no longer hardcoded empty.** This paragraph read
 * *"Phase 1 is inert — no state replicates yet (spec Phases → "Phase 1"), so the `hello` this class
 * sends carries empty `watermarks`/`projects`: there is nothing to resume or advertise until a later
 * phase's reconcile/pairing machinery exists to feed it"* — and its premise died when replication
 * landed. State DOES replicate now, `spoke-runtime.ts` tracks an applied position per project, and a
 * `hello` that reported `[]` regardless made the hub's `seedWatermark` dead code against every real
 * node: every reconnect resumed the whole scope from zero. `watermarks` now comes from the
 * `watermarks` option (still `[]` when unwired, which is honest rather than inert).
 *
 * **`projects` IS still hardcoded empty, and that one is not an oversight.** It feeds D2's pairing
 * PROPOSALS, and there is no consumer: `hub-router.ts`'s `hello` case deliberately OMITS `proposals`
 * from the `welcome` rather than computing one, because the hub has no store of another node's
 * adverts to compare against. Advertising into a hub that cannot use it would be motion, not
 * progress. Left for whoever builds the proposal store.
 *
 * **Nothing here is persisted, deliberately** — see the `watermarks` option.
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

/** `clusterHelloFrameSchema.watermarks` is `.max(500)`. Named here rather than inlined because the
 *  consequence of exceeding it is not a rejected field but a DROPPED frame — see `helloWatermarks()`. */
const HELLO_WATERMARKS_MAX = 500;

export interface ClusterLinkClientOptions {
  identity: StoredClusterNodeIdentity;
  hubUrl: string;
  /**
   * This node's own cezar version, carried on `hello` (D13: version skew is permanent, so every
   * frame reports it rather than assuming). Not derivable from `identity` or any other option here
   * — injected the same way `ServerDeps.version` is, by whoever boots this class.
   */
  version: string;
  /**
   * D38 — this node's applied position per scope, read FRESH at every `hello` (each reconnect calls
   * it again). Omitted, or returning `[]`, means "I report nothing", which the hub reads as position
   * zero and answers with a full replay of every scope: safe, and merely wasteful.
   *
   * **Must be a getter, not a value, and that is forced by construction order rather than taste.**
   * `cluster-routes.ts` does `new ClusterLinkClient(...)` → `.start()` → `startSpokeRuntime({ link })`,
   * so the runtime that HOLDS these numbers does not exist when this class is built, and it takes
   * this class as its own dependency. A value passed at construction could only ever be the empty
   * one. Same late-bound shape `buildHubReplication`'s `sendTo` already uses for `linkServer()`.
   * The first `hello` therefore fires before the runtime is wired and reports `[]` — truthful:
   * nothing has been applied yet.
   *
   * **Report what is known right now; persist NOTHING.** `spoke-runtime.ts` holds these in memory on
   * purpose (its `ProjectOutboxState` doc says losing them on restart is harmless), so after a
   * process restart `[]` is the TRUE answer and a full replay is the CORRECT one. The bug this
   * option closes is the narrower and far more common case: a reconnect WITHOUT a restart — a hub
   * blue-green (~10/day), a dropped socket, a network blip — where the runtime still holds live
   * numbers and the `hello` used to throw them away. Writing these to disk would reassert across a
   * restart a position this node cannot vouch for, turning a bounded over-send into a silent
   * under-send. Do not add durability here even though it looks like an improvement.
   *
   * The returned entries are validated and capped before they reach the wire — see
   * `helloWatermarks()`, and note that every guard there fails toward over-sending.
   */
  watermarks?: () => readonly ClusterWatermark[];
  now?: () => number;
  warn?: (message: string) => void;
  /** Full jitter over an exponential base. Injected so a test can pin it. */
  backoff?: LinkBackoffOptions;
  random?: () => number;
  /**
   * The EDGE credential (Cloudflare Access, `edge-auth.ts`) — headers proving this machine may
   * reach the hub's hostname at all, merged into every `dial()` upgrade request. Independent of,
   * and never a substitute for, the three `CLUSTER_LINK_*` node-auth headers below: on a key
   * collision the node-auth headers always win (see `dial()`), so an edge credential can never
   * overwrite the node principal. Injected rather than resolved in here directly, so a test can
   * hand it a literal; when omitted this class resolves it once, at construction, from the
   * environment via `resolveEdgeAuthHeaders()` — `undefined` (the zero-config path) unless
   * `CEZ_CLUSTER_ACCESS_CLIENT_ID`/`CEZ_CLUSTER_ACCESS_CLIENT_SECRET` are set.
   */
  edgeHeaders?: Readonly<Record<string, string>>;
  /**
   * How long ONE upgrade attempt may sit with no reply before it is torn down and retried.
   * Defaults to `DEFAULT_LINK_HANDSHAKE_TIMEOUT_MS`; injected so a test can pin it small.
   *
   * **This is not a tuning knob: it closes a permanent wedge.** Every other failure path in `dial()`
   * is edge-triggered: `unexpected-response` fires on an HTTP refusal, `close` fires on a socket
   * that opens and then goes away, and both funnel into `disconnect()` -> `scheduleReconnect()`. An
   * upgrade that receives *no reply at all* fires none of them, so without a timeout the client
   * stays in `connecting` forever — no error, no close, no retry, and a `health()` that reads
   * `connecting` rather than `offline`, so nothing downstream can tell a wedged link from a slow one
   * either.
   *
   * **CORRECTED 2026-08-23 (D40a) — this used to say "the ONLY thing that closes a permanent
   * wedge", and the word `only` was false in the direction that stops a reader looking further.**
   * `ws` receives this as its `handshakeTimeout` option, which bounds the HTTP 101 upgrade and
   * nothing above it. There is a second wedge one layer up, with the identical symptom and no cover
   * here at all: an upgrade that SUCCEEDS, on a socket the hub then never serves — a `hello` the hub
   * drops as unparseable (`link-server.ts` warns and returns, by D13's design), leaving
   * `helloReceived` false forever while the hub's own ping/pong keeps the socket healthy. No error,
   * no close, no retry, and `connecting` again — measured still `connecting` at t+13.2s, well past
   * this 10s timeout, precisely because the upgrade it bounds had already succeeded. That one is
   * closed HUB-side (a handshake deadline on `link-server.ts`'s existing reap tick, refusing with
   * `handshake-timeout`), because only the hub knows whether a socket it accepted ever said anything
   * it could use.
   *
   * That is not hypothetical, and not only a startup race: this server's own
   * `attachUpgradeFallback` deliberately does NOT destroy a socket whose path it recognizes but
   * whose handler has not registered yet ("the hang IS the safer error"), which is exactly the
   * window between `startServer` returning and `startClusterRuntime`'s `await loadNodeIdentity`
   * completing. Measured directly against a server that registers an `upgrade` listener and stays
   * silent: with no `handshakeTimeout` the client emitted nothing at all for 900ms and would have
   * waited indefinitely; with one it emitted `error('Opening handshake has timed out')` then
   * `close`, which is what lets `disconnect()` run at all.
   */
  handshakeTimeoutMs?: number;
}

export interface LinkBackoffOptions {
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_LINK_BACKOFF: LinkBackoffOptions = { baseMs: 1_000, maxMs: 60_000 };

/** Deliberately well under `DEFAULT_LINK_BACKOFF.baseMs * 10` so a wedged attempt is abandoned and
 *  retried on a timescale a human watching the roster would call "reconnecting", not "down". */
export const DEFAULT_LINK_HANDSHAKE_TIMEOUT_MS = 10_000;

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
  /** Resolved once, at construction — same idiom as `reconcile-transport.ts#createHttpReconcileTransport`
   *  resolving `fetchImpl` once rather than on every call. Throws `ClusterEdgeAuthConfigError`
   *  synchronously out of the constructor on a half-configured environment, so a misconfiguration
   *  fails the boot immediately rather than surfacing later as an unexplained reconnect loop. */
  private readonly edgeHeaders: Readonly<Record<string, string>> | undefined;

  constructor(private readonly options: ClusterLinkClientOptions) {
    super();
    this.edgeHeaders = options.edgeHeaders ?? resolveEdgeAuthHeaders();
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
      // Bounds an attempt that gets NO reply — see `handshakeTimeoutMs`. `ws` turns the expiry into
      // `error` followed by `close`, and it is that `close` (not the error, which is swallowed
      // below) that reaches `disconnect()` and schedules the retry.
      handshakeTimeout: this.options.handshakeTimeoutMs ?? DEFAULT_LINK_HANDSHAKE_TIMEOUT_MS,
      headers: {
        // Edge headers spread FIRST: the three node-auth headers below are set after, in the same
        // object literal, so they always win a key collision — an edge credential must never be
        // able to overwrite the node principal (see `edgeHeaders`'s own doc on `ClusterLinkClientOptions`).
        ...this.edgeHeaders,
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
      // The hello goes the instant the socket opens (D38's wiring): the hub replies to a `hello`,
      // so deferring this to any later signal would deadlock the handshake against itself. The
      // backoff reset that used to sit above this line does NOT belong here — see the `welcome`
      // branch below.
      this.sendHello(ws);
    });

    ws.on('message', (raw) => {
      if (this.ws !== ws) return; // a superseded socket's late message
      const frame = this.parseDownlink(raw);
      if (!frame) return;
      const lastFrameAt = new Date(this.now()).toISOString();

      if (frame.type === 'welcome') {
        // **D40a, 2026-08-23 — the backoff reset lives HERE, not in `ws.on('open')`.** It sat there
        // under the comment "a successful handshake resets the backoff", and an open socket is not a
        // completed handshake: the WebSocket upgrade succeeding says the hub's HTTP listener is
        // alive, nothing more. Every refusal reaches `open` first (the hub must accept the socket to
        // put a `refuse` frame on it) and every application-level wedge does too — so against a hub
        // that refuses, `this.attempt` was reset on every single attempt and `scheduleReconnect`
        // always computed `nextBackoffMs(0)` = uniform [0, baseMs). Measured: **11 reconnects in 5s,
        // ~2.2/second, indefinitely**, with the 60s cap unreachable on this path by construction.
        // A `welcome` is the first thing that proves the hub accepted this node AS this node, which
        // is the event "the backoff has done its job" actually refers to.
        //
        // **What this deliberately does NOT cover, so it is not later read as a regression:** a hub
        // that welcomes and then immediately drops the link still resets on every welcome, and
        // still reconnects at full speed. That is correct — the handshake genuinely completed each
        // time — and a flapping hub is a different fault with a different fix. The bug being closed
        // here is a link that NEVER completes and retries as though it had.
        this.attempt = 0;
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

  /**
   * The `watermarks` option's output, made safe to put on the wire. Every guard below fails toward
   * OVER-sending — a watermark dropped here is read by the hub as zero and replayed in full, which
   * costs one idempotent re-apply, whereas letting a bad one through costs the whole link.
   *
   * **Why a guard at all, on a number this node computed itself.** `writeFrame` does not validate:
   * it JSON-encodes and checks the byte bound only. An invalid `hello` is therefore SENT, and
   * `link-server.ts:272` drops it with a warn rather than refusing the connection — so the socket
   * stays open, the hub never records the handshake, and (since `connectedNodes()` was narrowed to
   * handshaken nodes for D30) that node gets no `welcome` and no fan-out at all, indefinitely,
   * while the spoke's own health still reads `online`. A silently half-dead link is a far worse
   * outcome than a wasted replay, and it is reachable from one malformed entry.
   *
   * Two concrete ways a well-meaning provider produces one, neither of them a bug on its side:
   *
   *  - **The stored shape is `.passthrough()`, the wire shape is `.strict()`.**
   *    `storedClusterWatermarkSchema` deliberately tolerates extra keys; `clusterWatermarkSchema`
   *    deliberately rejects them. Handing a stored watermark straight through is the obvious
   *    implementation and it is invalid on the wire. Hence the explicit five-field projection
   *    below rather than a `safeParse` of the caller's object — parsing alone would DROP such an
   *    entry, when the fix is to narrow it.
   *  - **`.max(500)` on the array.** More scopes than that and the whole frame is invalid, so the
   *    cap has to be enforced here rather than hoped for. Which 500 survive does not matter: the
   *    omitted ones replay from zero.
   */
  private helloWatermarks(): ClusterWatermark[] {
    const provider = this.options.watermarks;
    if (!provider) return [];

    let reported: readonly ClusterWatermark[];
    try {
      reported = provider();
    } catch (err) {
      // A throwing provider must not cost the handshake. Report nothing and replay in full.
      this.options.warn?.(
        `cluster link: the watermarks provider threw (${err instanceof Error ? err.message : String(err)}) — ` +
          'sending an empty hello watermark list, so the hub will replay every scope from zero rather than ' +
          'this node ' +
          'silently failing to connect',
      );
      return [];
    }

    const valid: ClusterWatermark[] = [];
    const rejected: string[] = [];
    for (const entry of reported) {
      // Narrow to exactly the wire fields FIRST — see the passthrough/strict note above. That
      // narrowing is the load-bearing part: `.strict()` rejects keys it does not know, which is
      // exactly what a stored watermark carries.
      //
      // The conditional spread on the two `.optional()` fields is NOT required for validity —
      // measured, not assumed: `clusterWatermarkSchema.safeParse({ scope: 'workspace', projectKey:
      // undefined, … })` succeeds, because `.strict()` polices unknown keys, not known ones holding
      // `undefined`. It is here so the object carries no `undefined`-valued own key, which keeps an
      // exact-equality assertion on the parsed result meaningful.
      const parsed = clusterWatermarkSchema.safeParse({
        scope: entry.scope,
        ...(entry.projectKey !== undefined ? { projectKey: entry.projectKey } : {}),
        appliedThroughHubSeq: entry.appliedThroughHubSeq,
        ackedThroughHubSeq: entry.ackedThroughHubSeq,
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
      });
      // The PARSED value, never the caller's object — the thing validated has to be the thing sent.
      if (parsed.success) valid.push(parsed.data);
      else rejected.push(`${entry.scope}:${entry.projectKey ?? ''}`);
    }
    if (rejected.length > 0) {
      this.options.warn?.(
        `cluster link: ${rejected.length} of ${reported.length} reported watermark(s) are not valid on the ` +
          `wire and were dropped from this hello: ${rejected.slice(0, 5).join(', ')}${
            rejected.length > 5 ? ', …' : ''
          }. Those scopes will be replayed from zero.`,
      );
    }

    if (valid.length > HELLO_WATERMARKS_MAX) {
      this.options.warn?.(
        `cluster link: ${valid.length} watermarks exceed the hello frame's ${HELLO_WATERMARKS_MAX}-entry cap — ` +
          `reporting the first ${HELLO_WATERMARKS_MAX} and letting the rest replay from zero. Sending them all ` +
          'would make the whole frame invalid, and the hub DROPS an invalid hello rather than refusing it, ' +
          'which would leave this node connected but never handshaken.',
      );
      return valid.slice(0, HELLO_WATERMARKS_MAX);
    }
    return valid;
  }

  private sendHello(ws: WebSocket): void {
    const frame: ClusterUplinkFrame = {
      type: 'hello',
      protocol: CLUSTER_PROTOCOL,
      nodeId: this.options.identity.nodeId,
      nodeName: this.options.identity.nodeName,
      version: this.options.version,
      labels: this.options.identity.labels,
      // Read fresh on EVERY hello, never cached across reconnects — the whole point is that the
      // number moved while the link was down. See the `watermarks` option.
      watermarks: this.helloWatermarks(),
      // Still empty, deliberately, and not for the same reason: nothing consumes it. See the module doc.
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
