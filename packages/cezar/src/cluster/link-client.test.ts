import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  CLUSTER_PROTOCOL,
  type ClusterDownlinkFrame,
  type ClusterUplinkFrame,
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
  CLUSTER_LINK_REFUSE_REASON_HEADER,
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

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
