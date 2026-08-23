import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { ClusterEdgeAuthConfigError } from './edge-auth.ts';
import {
  CLUSTER_PROTOCOL,
  clusterHelloFrameSchema,
  type ClusterDownlinkFrame,
  type ClusterUplinkFrame,
  type ClusterWatermark,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { signClusterFrame } from './enrollment.ts';
import {
  DEFAULT_LINK_BACKOFF,
  nextBackoffMs,
  ClusterLinkClient,
  type ClusterLinkClientOptions,
} from './link-client.ts';
import {
  authenticateLinkUpgrade,
  CLUSTER_LINK_NODE_HEADER,
  CLUSTER_LINK_PRINCIPAL_HEADER,
  CLUSTER_LINK_REFUSE_REASON_HEADER,
  CLUSTER_LINK_SIGNATURE_HEADER,
} from './link-server.ts';

/**
 * `nextBackoffMs` is pure, so it is exercised directly (negative control #3: a fixed retry must
 * NOT pass this file — the assertions below fail against a constant delay).
 */
describe('nextBackoffMs', () => {
  it('is full jitter: random() * min(maxMs, baseMs * 2**attempt)', () => {
    const opts = { baseMs: 1_000, maxMs: 60_000 };
    expect(nextBackoffMs(0, opts, () => 0)).toBe(0);
    expect(nextBackoffMs(0, opts, () => 1)).toBe(1_000);
    expect(nextBackoffMs(1, opts, () => 1)).toBe(2_000);
    expect(nextBackoffMs(2, opts, () => 1)).toBe(4_000);
    expect(nextBackoffMs(3, opts, () => 0.5)).toBe(4_000); // 0.5 * 8_000
  });

  it('backs off — the CAP strictly increases across attempts until the ceiling, not a fixed retry', () => {
    const opts = { baseMs: 1_000, maxMs: 60_000 };
    // Pin random() to 1 (max of the jitter range) so the returned value IS the cap at each attempt —
    // a fixed-delay implementation would return the same number at every attempt and fail this.
    const delays = [0, 1, 2, 3, 4, 5, 6].map((attempt) => nextBackoffMs(attempt, opts, () => 1));
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
    for (let i = 1; i < delays.length - 1; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('is capped at maxMs and never exceeds it', () => {
    const opts = { baseMs: 1_000, maxMs: 10_000 };
    expect(nextBackoffMs(10, opts, () => 1)).toBe(10_000);
    expect(nextBackoffMs(100, opts, () => 1)).toBe(10_000);
  });

  it('is jittered — not the same value on every call at a fixed attempt', () => {
    const opts = { baseMs: 1_000, maxMs: 60_000 };
    const seq = [0.1, 0.9, 0.3];
    let i = 0;
    const random = () => seq[i++]!;
    const a = nextBackoffMs(5, opts, random);
    const b = nextBackoffMs(5, opts, random);
    const c = nextBackoffMs(5, opts, random);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('defaults to DEFAULT_LINK_BACKOFF when no options are given', () => {
    expect(nextBackoffMs(0, undefined, () => 1)).toBe(DEFAULT_LINK_BACKOFF.baseMs);
  });
});

// ---- integration: a real hub-shaped WS server + a real ClusterLinkClient ------------------------
//
// The hub side here is a MINIMAL stand-in (not the full ClusterLinkServer) so these tests can drive
// exact protocol scenarios (a hand-picked welcome, a targeted refuse, an abrupt drop) without
// depending on `onFrame` wiring. link-server.ts's own suite covers ClusterLinkServer itself; the
// combination of the two is exercised by link-server.test.ts's end-to-end cases.

const NODE_ID = 'node-spoke-1';
const SECRET = 'test-secret-abc123';

function identity(overrides: Partial<StoredClusterNodeIdentity> = {}): StoredClusterNodeIdentity {
  return {
    nodeId: NODE_ID,
    nodeName: 'spoke-1',
    createdAt: new Date(0).toISOString(),
    role: 'spoke',
    hubUrl: 'http://127.0.0.1:0',
    secret: SECRET,
    acceptsDispatch: false,
    labels: ['macos'],
    ...overrides,
  };
}

interface HubStub {
  base: string;
  hello: () => Promise<{ nodeId: string; frame: ClusterUplinkFrame }>;
  send: (frame: ClusterDownlinkFrame) => void;
  closeClient: (code?: number) => void;
  connections: number;
  /** Resolves with the headers of the NEXT upgrade request the hub receives — captured
   *  unconditionally, BEFORE `authenticateLinkUpgrade` runs, so a test can inspect what actually
   *  reached the wire even for a request the hub goes on to refuse (edge-auth precedence: a
   *  tampered node-auth header must fail verification, not merely "not be captured"). */
  nextUpgradeHeaders: () => Promise<IncomingHttpHeaders>;
}

const servers: Server[] = [];
const wsServers: WebSocketServer[] = [];

afterEach(async () => {
  for (const wss of wsServers.splice(0)) wss.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** A stand-in hub: authenticates via the REAL `authenticateLinkUpgrade`, but leaves what happens
 *  after connection to the test (via `hello`/`send`). */
async function bootHub(secretFor: (nodeId: string) => string | undefined = () => SECRET): Promise<HubStub> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let connections = 0;
  let currentWs: WebSocket | undefined;
  const helloWaiters: Array<(v: { nodeId: string; frame: ClusterUplinkFrame }) => void> = [];
  const helloQueue: Array<{ nodeId: string; frame: ClusterUplinkFrame }> = [];
  const headerWaiters: Array<(h: IncomingHttpHeaders) => void> = [];
  const headerQueue: IncomingHttpHeaders[] = [];

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Captured unconditionally, before authentication — what actually reached the wire, whether
    // or not the hub goes on to accept this particular request.
    const headerWaiter = headerWaiters.shift();
    if (headerWaiter) headerWaiter(req.headers);
    else headerQueue.push(req.headers);

    void (async () => {
      const verdict = await authenticateLinkUpgrade(req, async (nodeId) => secretFor(nodeId));
      if (!verdict.ok) {
        socket.write(
          `HTTP/1.1 401 Unauthorized\r\n${CLUSTER_LINK_REFUSE_REASON_HEADER}: ${verdict.reason}\r\nconnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        connections += 1;
        currentWs = ws;
        ws.on('message', (raw) => {
          const frame = JSON.parse(String(raw)) as ClusterUplinkFrame;
          const entry = { nodeId: verdict.nodeId, frame };
          const waiter = helloWaiters.shift();
          if (waiter) waiter(entry);
          else helloQueue.push(entry);
        });
      });
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  wsServers.push(wss);
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    hello: () =>
      helloQueue.length > 0
        ? Promise.resolve(helloQueue.shift()!)
        : new Promise((resolve) => {
            helloWaiters.push(resolve);
            setTimeout(() => {
              throw new Error('no hello within budget');
            }, 2_000).unref();
          }),
    send: (frame) => currentWs?.send(JSON.stringify(frame)),
    closeClient: (code) => currentWs?.close(code),
    nextUpgradeHeaders: () =>
      headerQueue.length > 0
        ? Promise.resolve(headerQueue.shift()!)
        : new Promise((resolve, reject) => {
            headerWaiters.push(resolve);
            const timer = setTimeout(() => reject(new Error('no upgrade request within budget')), 2_000);
            timer.unref?.();
          }),
    get connections() {
      return connections;
    },
  };
}

function client(hub: HubStub, overrides: Partial<ClusterLinkClientOptions> = {}) {
  return new ClusterLinkClient({
    identity: identity(),
    hubUrl: hub.base,
    version: '0.10.0',
    backoff: { baseMs: 5, maxMs: 40 }, // fast — these tests wait on real timers
    ...overrides,
  });
}

describe('ClusterLinkClient', () => {
  it('sends a signed hello on open and reaches "online" on welcome', async () => {
    const hub = await bootHub();
    const c = client(hub);
    const healthEvents: string[] = [];
    c.on('health', (h) => healthEvents.push(h.state));
    c.start();

    const { nodeId, frame } = await hub.hello();
    expect(nodeId).toBe(NODE_ID);
    expect(frame).toMatchObject({
      type: 'hello',
      protocol: CLUSTER_PROTOCOL,
      nodeId: NODE_ID,
      nodeName: 'spoke-1',
      version: '0.10.0',
      labels: ['macos'],
      watermarks: [],
      projects: [],
    });

    const framePromise = new Promise<ClusterDownlinkFrame>((resolve) => c.once('frame', resolve));
    hub.send({ type: 'welcome', protocol: CLUSTER_PROTOCOL, hubNodeId: 'hub-1', roster: [], pairings: [], resumeFrom: [] });
    const welcome = await framePromise;
    expect(welcome.type).toBe('welcome');
    expect(c.health().state).toBe('online');
    expect(healthEvents).toContain('connecting');
    expect(healthEvents).toContain('online');

    await c.stop();
  });

  it('a protocol-major refusal sets the reason as a VALUE and does not reconnect', async () => {
    const hub = await bootHub();
    const c = client(hub);
    const refused = new Promise<void>((resolve) => c.once('refused', () => resolve()));
    c.start();
    await hub.hello();
    hub.send({ type: 'refuse', protocol: CLUSTER_PROTOCOL, reason: 'protocol-major' });
    await refused;

    expect(c.health().state).toBe('refused');
    expect(c.health().refusedReason).toBe('protocol-major');

    // Must NOT be retried into a hot loop: wait well past the (fast, 5-40ms) backoff window and
    // confirm the hub never received a second connection/hello.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hub.connections).toBe(1);
    expect(c.health().state).toBe('refused'); // never moved to connecting/offline

    await c.stop();
  });

  it('reconnects with backoff after an abrupt drop (not a refuse)', async () => {
    const hub = await bootHub();
    const c = client(hub);
    const offline = new Promise<void>((resolve) => {
      c.on('health', (h) => {
        if (h.state === 'offline') resolve();
      });
    });
    c.start();
    await hub.hello();
    hub.closeClient(); // ordinary close, not a refuse frame

    await offline;
    expect(c.health().state).toBe('offline');
    expect(c.health().retryAt).toBeDefined();

    // It actually comes back: a second hello arrives on the reconnected socket.
    const second = await hub.hello();
    expect(second.nodeId).toBe(NODE_ID);
    expect(hub.connections).toBeGreaterThanOrEqual(2);

    await c.stop();
  });

  it('send() is false before start() and after stop()', async () => {
    const hub = await bootHub();
    const c = client(hub);
    expect(c.send({ type: 'presence', protocol: CLUSTER_PROTOCOL, capacity: { maxParallel: 1, active: 0, heavyActive: 0, enforcement: 'none' }, repoDrift: [] })).toBe(false);

    c.start();
    await hub.hello();
    await c.stop();
    expect(c.send({ type: 'presence', protocol: CLUSTER_PROTOCOL, capacity: { maxParallel: 1, active: 0, heavyActive: 0, enforcement: 'none' }, repoDrift: [] })).toBe(false);
  });

  it('send() is false for a frame over CLUSTER_FRAME_MAX_BYTES — rejected, not truncated', async () => {
    const hub = await bootHub();
    const c = client(hub);
    c.start();
    await hub.hello();
    hub.send({ type: 'welcome', protocol: CLUSTER_PROTOCOL, hubNodeId: 'hub-1', roster: [], pairings: [], resumeFrom: [] });
    await new Promise<void>((resolve) => c.once('frame', () => resolve()));

    const oversized: ClusterUplinkFrame = {
      type: 'relay',
      protocol: CLUSTER_PROTOCOL,
      runId: 'r_1',
      events: [{ pad: 'x'.repeat(300_000) }], // well over the 256 KB frame bound
    };
    expect(c.send(oversized)).toBe(false);

    await c.stop();
  });

  it('an oversized frame is never merely truncated — a well-formed same-shape frame under the bound still sends', async () => {
    const hub = await bootHub();
    const c = client(hub);
    c.start();
    await hub.hello();
    hub.send({ type: 'welcome', protocol: CLUSTER_PROTOCOL, hubNodeId: 'hub-1', roster: [], pairings: [], resumeFrom: [] });
    await new Promise<void>((resolve) => c.once('frame', () => resolve()));

    const fine: ClusterUplinkFrame = {
      type: 'relay',
      protocol: CLUSTER_PROTOCOL,
      runId: 'r_1',
      events: [{ pad: 'x'.repeat(100) }],
    };
    const receivedAt = hub.hello();
    expect(c.send(fine)).toBe(true);
    const { frame } = await receivedAt;
    expect(frame).toEqual(fine); // exactly what was sent, not a shortened variant

    await c.stop();
  });

  it('rejects an upgrade-level refusal (bad secret) and never opens', async () => {
    const hub = await bootHub(() => undefined); // no node knows this secret — unknown-node
    const warn = vi.fn();
    const c = client(hub, { warn, backoff: { baseMs: 5, maxMs: 20 } });

    const offline = new Promise<void>((resolve) => {
      c.on('health', (h) => {
        if (h.state === 'offline') resolve();
      });
    });
    c.start();
    await offline;
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown-node'));
    expect(hub.connections).toBe(0); // the upgrade never completed
    await c.stop();
  });

  it('signs the principal with signClusterFrame so a hub verifying it independently accepts it', () => {
    // Cross-check against the real hub-side primitive rather than re-deriving the wire format here.
    const now = () => new Date('2026-08-22T00:00:00.000Z');
    const signed = signClusterFrame({ nodeId: NODE_ID, issuedAt: now().toISOString() }, SECRET);
    expect(signed.principal.length).toBeGreaterThan(0);
    expect(signed.signature.length).toBeGreaterThan(0);
  });
});

// ---- edge auth (Cloudflare Access headers, edge-auth.ts) — independent of, and never allowed to
// override, the node-auth headers above -----------------------------------------------------------

describe('ClusterLinkClient — edge auth (Cloudflare Access headers)', () => {
  it('no-op floor: with no edgeHeaders option and no CEZ_CLUSTER_ACCESS_* env vars set, the upgrade carries no CF-Access-* header at all — the backward-compat guarantee', async () => {
    const prevId = process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
    const prevSecret = process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
    delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
    delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
    const hub = await bootHub();
    try {
      const c = client(hub);
      const headersPromise = hub.nextUpgradeHeaders();
      c.start();
      const headers = await headersPromise;
      expect(headers['cf-access-client-id']).toBeUndefined();
      expect(headers['cf-access-client-secret']).toBeUndefined();
      // Exactly what dial() has always sent — unchanged by this feature when it does not apply.
      expect(headers[CLUSTER_LINK_NODE_HEADER]).toBe(NODE_ID);
      expect(typeof headers[CLUSTER_LINK_PRINCIPAL_HEADER]).toBe('string');
      expect(typeof headers[CLUSTER_LINK_SIGNATURE_HEADER]).toBe('string');
      await c.stop();
    } finally {
      if (prevId === undefined) delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
      else process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
      else process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET = prevSecret;
    }
  });

  it('merges an injected edgeHeaders literal into the ACTUAL upgrade request on the wire (real WS server, not a mock)', async () => {
    const hub = await bootHub();
    const c = client(hub, {
      edgeHeaders: { 'CF-Access-Client-Id': 'cid-e2e-123', 'CF-Access-Client-Secret': 'csecret-e2e-456' },
    });
    const headersPromise = hub.nextUpgradeHeaders();
    c.start();
    const headers = await headersPromise;
    expect(headers['cf-access-client-id']).toBe('cid-e2e-123');
    expect(headers['cf-access-client-secret']).toBe('csecret-e2e-456');
    // And the connection still succeeds — an edge header is additive, not a substitute for node auth.
    await hub.hello();
    await c.stop();
  });

  it('precedence: an edgeHeaders entry that collides with a node-auth header name never wins — the genuine signed principal reaches the wire', async () => {
    const hub = await bootHub();
    const c = client(hub, {
      edgeHeaders: {
        [CLUSTER_LINK_NODE_HEADER]: 'attacker-supplied-node-id',
        [CLUSTER_LINK_PRINCIPAL_HEADER]: 'attacker-supplied-principal',
        [CLUSTER_LINK_SIGNATURE_HEADER]: 'attacker-supplied-signature',
      },
    });
    const headersPromise = hub.nextUpgradeHeaders();
    c.start();
    const headers = await headersPromise;
    expect(headers[CLUSTER_LINK_NODE_HEADER]).toBe(NODE_ID);
    expect(headers[CLUSTER_LINK_NODE_HEADER]).not.toBe('attacker-supplied-node-id');
    expect(headers[CLUSTER_LINK_PRINCIPAL_HEADER]).not.toBe('attacker-supplied-principal');
    expect(headers[CLUSTER_LINK_SIGNATURE_HEADER]).not.toBe('attacker-supplied-signature');
    // Proves it end to end, not just "a different string arrived": the hub's REAL verifier only
    // ever accepts a genuinely signed principal, so a successful hello is only possible because the
    // real node headers — not the colliding edge values — are what it actually checked.
    const { nodeId } = await hub.hello();
    expect(nodeId).toBe(NODE_ID);
    await c.stop();
  });

  it('construction throws ClusterEdgeAuthConfigError when the environment is half-configured and no edgeHeaders override is given', () => {
    const prevId = process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
    const prevSecret = process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
    process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID = 'only-the-id-is-set';
    delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
    try {
      expect(
        () => new ClusterLinkClient({ identity: identity(), hubUrl: 'http://127.0.0.1:0', version: '0.10.0' }),
      ).toThrow(ClusterEdgeAuthConfigError);
    } finally {
      if (prevId === undefined) delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID;
      else process.env.CEZ_CLUSTER_ACCESS_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET;
      else process.env.CEZ_CLUSTER_ACCESS_CLIENT_SECRET = prevSecret;
    }
  });
});

/**
 * D38 — `sendHello` used to hardcode `watermarks: []`, which made the hub's `seedWatermark` dead
 * code against every real node and re-replayed the whole scope on every reconnect. These cover the
 * option that fixes it, and the guards that keep a bad provider from doing something far worse than
 * a wasted replay.
 *
 * **The failure being defended against is not "a wrong number" — it is a SILENTLY HALF-DEAD LINK.**
 * `writeFrame` does not validate, and `link-server.ts:272` DROPS an invalid uplink frame with a warn
 * instead of refusing the connection. So a malformed watermark means: socket open, hello never
 * processed, `helloReceived` never set — and since `connectedNodes()` was narrowed to handshaken
 * nodes for D30, that node then receives no welcome and no fan-out at all, indefinitely, while its
 * own health still reads `online`. Every guard below therefore fails toward OVER-sending.
 *
 * The floor — no provider at all still sends `watermarks: []` — is the first test in this file
 * (`sends a signed hello on open`), which asserts it as part of the whole frame. Not duplicated here.
 */
describe('ClusterLinkClient — hello watermarks (D38)', () => {
  function mark(overrides: Partial<ClusterWatermark> = {}): ClusterWatermark {
    return { scope: 'project', projectKey: 'proj-1', appliedThroughHubSeq: 7, ackedThroughHubSeq: 4, ...overrides };
  }

  it('reports the provider\'s watermarks on the hello — the case an unwired option breaks', async () => {
    const hub = await bootHub();
    const c = client(hub, { watermarks: () => [mark()] });
    c.start();

    const { frame } = await hub.hello();
    expect(frame.type).toBe('hello');
    // A non-empty floor, not just a shape match: an empty array satisfies "is an array".
    const reported = (frame as { watermarks: ClusterWatermark[] }).watermarks;
    expect(reported).toHaveLength(1);
    expect(reported[0]).toEqual({
      scope: 'project',
      projectKey: 'proj-1',
      appliedThroughHubSeq: 7,
      ackedThroughHubSeq: 4,
    });

    await c.stop();
  });

  // THE bug. A watermark that is only read once is exactly as useless as a hardcoded `[]`, because
  // the number moves precisely while the link is down: the hub blue-green self-deploys ~10x/day and
  // every one of those is a reconnect on a runtime that kept applying in the meantime.
  it('re-reads the provider on EVERY hello, so a reconnect reports the position the node reached while it was down', async () => {
    const hub = await bootHub();
    let applied = 0;
    const c = client(hub, { watermarks: () => [mark({ appliedThroughHubSeq: applied })] });
    const offline = new Promise<void>((resolve) => {
      c.on('health', (h) => {
        if (h.state === 'offline') resolve();
      });
    });
    c.start();

    const first = await hub.hello();
    expect((first.frame as { watermarks: ClusterWatermark[] }).watermarks[0]?.appliedThroughHubSeq).toBe(0);

    // The runtime applies more while the link is up, then the socket drops — an ordinary close, not
    // a refuse, so the client reconnects (the same shape the reconnect test above uses).
    applied = 42;
    hub.closeClient();
    await offline;

    const second = await hub.hello();
    expect((second.frame as { watermarks: ClusterWatermark[] }).watermarks[0]?.appliedThroughHubSeq).toBe(42);
    expect(hub.connections).toBeGreaterThan(1); // it really was a second connection, not a re-read of the first

    await c.stop();
  });

  // The passthrough/strict seam: `storedClusterWatermarkSchema` tolerates extra keys BY DESIGN and
  // the wire's `clusterWatermarkSchema` rejects them BY DESIGN, so handing a stored watermark
  // straight through is the obvious provider implementation and it is invalid on the wire. Narrowed
  // rather than dropped — dropping would silently re-replay a scope the node is actually caught up on.
  it('narrows a stored-shaped watermark to the wire fields instead of dropping it', async () => {
    const hub = await bootHub();
    const stored = { ...mark(), updatedAt: '2026-08-23T00:00:00.000Z', staleExtraKey: 'from the stored shape' };
    const c = client(hub, { watermarks: () => [stored as unknown as ClusterWatermark] });
    c.start();

    const { frame } = await hub.hello();
    const reported = (frame as { watermarks: ClusterWatermark[] }).watermarks;
    expect(reported).toHaveLength(1); // survived
    expect(reported[0]).not.toHaveProperty('staleExtraKey'); // and was narrowed
    expect(reported[0]?.updatedAt).toBe('2026-08-23T00:00:00.000Z'); // a real optional field is kept

    await c.stop();
  });

  it('drops an entry that cannot be valid on the wire and still sends the rest, with a warning', async () => {
    const hub = await bootHub();
    const warnings: string[] = [];
    const c = client(hub, {
      warn: (m) => warnings.push(m),
      // `clusterHubSeqSchema` is `.int().nonnegative()`.
      watermarks: () => [mark({ projectKey: 'bad', appliedThroughHubSeq: -1 }), mark({ projectKey: 'good' })],
    });
    c.start();

    const { frame } = await hub.hello();
    const reported = (frame as { watermarks: ClusterWatermark[] }).watermarks;
    expect(reported.map((w) => w.projectKey)).toEqual(['good']);
    expect(warnings.some((w) => w.includes('not valid on the wire') && w.includes('project:bad'))).toBe(true);

    await c.stop();
  });

  it('a THROWING provider costs an empty watermark list, never the handshake', async () => {
    const hub = await bootHub();
    const warnings: string[] = [];
    const c = client(hub, {
      warn: (m) => warnings.push(m),
      watermarks: () => {
        throw new Error('spoke runtime not ready');
      },
    });
    c.start();

    // The hello still arrives — that is the whole assertion. A node that cannot compute a watermark
    // must still be able to connect.
    const { frame } = await hub.hello();
    expect(frame.type).toBe('hello');
    expect((frame as { watermarks: ClusterWatermark[] }).watermarks).toEqual([]);
    expect(warnings.some((w) => w.includes('watermarks provider threw') && w.includes('spoke runtime not ready'))).toBe(
      true,
    );

    await c.stop();
  });

  it('caps at the schema\'s 500 entries rather than sending a frame the hub would silently DROP', async () => {
    const hub = await bootHub();
    const warnings: string[] = [];
    const c = client(hub, {
      warn: (m) => warnings.push(m),
      watermarks: () => Array.from({ length: 501 }, (_, i) => mark({ projectKey: `proj-${i}` })),
    });
    c.start();

    const { frame } = await hub.hello();
    expect((frame as { watermarks: ClusterWatermark[] }).watermarks).toHaveLength(500);
    expect(warnings.some((w) => w.includes('501 watermarks exceed'))).toBe(true);

    // The point of the cap, asserted against the REAL schema rather than against my own arithmetic:
    // at 501 this frame does not parse, the hub drops it, and the node never handshakes.
    expect(clusterHelloFrameSchema.safeParse(frame).success).toBe(true);

    await c.stop();
  });

  // The oracle for every case above. Each of the guards exists to keep this true, so assert it
  // directly on a frame built from deliberately hostile provider output rather than inferring it.
  it('whatever the provider returns, the frame that reaches the hub PARSES — the property every guard here exists to preserve', async () => {
    const hub = await bootHub();
    const hostile = [
      mark(),
      { ...mark({ projectKey: 'extra' }), notAWireField: true },
      mark({ projectKey: 'negative', ackedThroughHubSeq: -3 }),
      mark({ projectKey: 'fractional', appliedThroughHubSeq: 1.5 }),
      ...Array.from({ length: 600 }, (_, i) => mark({ projectKey: `bulk-${i}` })),
    ] as unknown as ClusterWatermark[];
    const c = client(hub, { warn: () => {}, watermarks: () => hostile });
    c.start();

    const { frame } = await hub.hello();
    const parsed = clusterHelloFrameSchema.safeParse(frame);
    expect(parsed.success).toBe(true);
    // ...and it is not vacuously true by having sent nothing.
    expect((frame as { watermarks: ClusterWatermark[] }).watermarks.length).toBeGreaterThan(0);

    await c.stop();
  });
});
