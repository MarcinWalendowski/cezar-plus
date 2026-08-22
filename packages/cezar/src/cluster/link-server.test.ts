import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_PROTOCOL,
  type ClusterDownlinkFrame,
  type ClusterUplinkFrame,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { signClusterFrame } from './enrollment.ts';
import {
  authenticateLinkUpgrade,
  ClusterLinkServer,
  CLUSTER_LINK_NODE_HEADER,
  CLUSTER_LINK_PRINCIPAL_HEADER,
  CLUSTER_LINK_REFUSE_REASON_HEADER,
  CLUSTER_LINK_SIGNATURE_HEADER,
  type ClusterLinkServerOptions,
} from './link-server.ts';

const NODE_ID = 'node-a';
const SECRET = 'shhh-secret';

function fakeReq(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as IncomingMessage;
}

function signedHeaders(nodeId: string, secret: string, issuedAt: string): Record<string, string> {
  const signed = signClusterFrame({ nodeId, issuedAt }, secret);
  return {
    [CLUSTER_LINK_NODE_HEADER]: nodeId,
    [CLUSTER_LINK_PRINCIPAL_HEADER]: signed.principal,
    [CLUSTER_LINK_SIGNATURE_HEADER]: signed.signature,
  };
}

describe('authenticateLinkUpgrade', () => {
  const lookup = async (nodeId: string) => (nodeId === NODE_ID ? SECRET : undefined);

  it('admits a correctly signed, fresh principal', async () => {
    const headers = signedHeaders(NODE_ID, SECRET, new Date().toISOString());
    const verdict = await authenticateLinkUpgrade(fakeReq(headers), lookup);
    expect(verdict).toEqual({ ok: true, nodeId: NODE_ID });
  });

  it('refuses missing headers as bad-signature', async () => {
    expect(await authenticateLinkUpgrade(fakeReq({}), lookup)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses an unknown node — the secret lookup finds nothing', async () => {
    const headers = signedHeaders('someone-else', 'whatever', new Date().toISOString());
    expect(await authenticateLinkUpgrade(fakeReq(headers), lookup)).toEqual({ ok: false, reason: 'unknown-node' });
  });

  it('refuses a tampered signature as bad-signature (secret is known, HMAC is wrong)', async () => {
    const headers = signedHeaders(NODE_ID, 'wrong-secret', new Date().toISOString());
    expect(await authenticateLinkUpgrade(fakeReq(headers), lookup)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('distinguishes stale-principal from bad-signature — a correctly signed but old principal', async () => {
    const oldIssuedAt = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 minutes ago
    const headers = signedHeaders(NODE_ID, SECRET, oldIssuedAt);
    const verdict = await authenticateLinkUpgrade(fakeReq(headers), lookup, { maxAgeMs: 120_000 });
    expect(verdict).toEqual({ ok: false, reason: 'stale-principal' });
  });

  it('a claimed nodeId header that disagrees with the verified payload is bad-signature, not admitted', async () => {
    // The signed principal really is for NODE_ID, but the unsigned lookup header lies about it.
    const signed = signClusterFrame({ nodeId: NODE_ID, issuedAt: new Date().toISOString() }, SECRET);
    const headers = {
      [CLUSTER_LINK_NODE_HEADER]: 'someone-else',
      [CLUSTER_LINK_PRINCIPAL_HEADER]: signed.principal,
      [CLUSTER_LINK_SIGNATURE_HEADER]: signed.signature,
    };
    // lookupSecret('someone-else') would need to happen to return SECRET for this to matter; give
    // it the same secret to isolate the nodeId cross-check from a plain unknown-node result.
    const verdict = await authenticateLinkUpgrade(fakeReq(headers), async () => SECRET);
    expect(verdict).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('an internal lookup failure refuses as internal, never throws', async () => {
    const headers = signedHeaders(NODE_ID, SECRET, new Date().toISOString());
    const verdict = await authenticateLinkUpgrade(
      fakeReq(headers),
      async () => {
        throw new Error('store unavailable');
      },
    );
    expect(verdict).toEqual({ ok: false, reason: 'internal' });
  });
});

// ---- integration: a real ClusterLinkServer over real sockets ------------------------------------

const servers: Server[] = [];
const hubs: ClusterLinkServer[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function hubIdentity(): StoredClusterNodeIdentity {
  return {
    nodeId: 'hub-1',
    nodeName: 'hub',
    createdAt: new Date(0).toISOString(),
    role: 'hub',
    acceptsDispatch: false,
    labels: [],
  };
}

async function boot(
  onFrame: ClusterLinkServerOptions['onFrame'],
  overrides: Partial<ClusterLinkServerOptions> = {},
): Promise<{ url: string; base: string; server: ClusterLinkServer }> {
  const httpServer = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const server = new ClusterLinkServer({
    identity: hubIdentity(),
    lookupSecret: async (nodeId) => (nodeId === NODE_ID ? SECRET : undefined),
    onFrame,
    ...overrides,
  });
  server.attach(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  servers.push(httpServer);
  hubs.push(server);
  const { port } = httpServer.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/api/v1/cluster/link`, base: `http://127.0.0.1:${port}`, server };
}

/** A raw client — bypasses `ClusterLinkClient` entirely so a test can send malformed/oversized/
 *  cockpit-shaped payloads that the typed client would never construct. */
function connectRaw(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const frames: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];
  ws.on('message', (raw) => {
    let frame: unknown;
    try {
      frame = JSON.parse(String(raw));
    } catch {
      frame = { raw: String(raw) };
    }
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  return {
    ws,
    send: (raw: unknown) => ws.send(typeof raw === 'string' ? raw : JSON.stringify(raw)),
    next: (timeoutMs = 1_500): Promise<unknown> =>
      frames.length > 0
        ? Promise.resolve(frames.shift())
        : new Promise((resolve, reject) => {
            waiters.push(resolve);
            setTimeout(() => reject(new Error(`no frame within ${timeoutMs}ms`)), timeoutMs).unref();
          }),
    waitOpen: () =>
      new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      }),
    waitUnexpectedResponse: () =>
      new Promise<{ status: number | undefined; reason: string | undefined }>((resolve) => {
        ws.on('unexpected-response', (_req, res) => {
          const raw = res.headers[CLUSTER_LINK_REFUSE_REASON_HEADER];
          resolve({ status: res.statusCode, reason: Array.isArray(raw) ? raw[0] : raw });
          res.resume();
        });
      }),
    waitClose: () => new Promise<number>((resolve) => ws.on('close', (code) => resolve(code))),
  };
}

async function connectNode(url: string) {
  const c = connectRaw(url, signedHeaders(NODE_ID, SECRET, new Date().toISOString()));
  await c.waitOpen();
  return c;
}

describe('ClusterLinkServer', () => {
  it('routes an admitted hello to onFrame and sends back whatever it returns', async () => {
    const onFrame = vi.fn(async (nodeId: string, frame: ClusterUplinkFrame): Promise<ClusterDownlinkFrame[]> => {
      expect(nodeId).toBe(NODE_ID);
      expect(frame.type).toBe('hello');
      return [{ type: 'welcome', protocol: CLUSTER_PROTOCOL, hubNodeId: 'hub-1', roster: [], pairings: [], resumeFrom: [] }];
    });
    const { url, server } = await boot(onFrame);
    const c = await connectNode(url);

    c.send({
      type: 'hello',
      protocol: CLUSTER_PROTOCOL,
      nodeId: NODE_ID,
      nodeName: 'spoke-1',
      version: '0.10.0',
      labels: [],
      watermarks: [],
      projects: [],
    });

    const welcome = await c.next();
    expect(welcome).toMatchObject({ type: 'welcome', hubNodeId: 'hub-1' });
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(server.connectedNodes()).toEqual([NODE_ID]);
    c.ws.close();
  });

  it('a protocol.major mismatch refuses with the reason as a VALUE, before onFrame ever runs', async () => {
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url } = await boot(onFrame);
    const c = await connectNode(url);

    c.send({
      type: 'hello',
      protocol: { major: 999, minor: 0 },
      nodeId: NODE_ID,
      nodeName: 'spoke-1',
      version: '0.10.0',
      labels: [],
      watermarks: [],
      projects: [],
    });

    const refuse = await c.next();
    expect(refuse).toMatchObject({ type: 'refuse', reason: 'protocol-major' });
    expect(onFrame).not.toHaveBeenCalled();
    const closeCode = await c.waitClose();
    expect(closeCode).toBe(1008);
  });

  it('rejects the upgrade with a named reason header when auth fails — never completes the handshake', async () => {
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url } = await boot(onFrame);
    const c = connectRaw(url); // no auth headers at all

    const { status, reason } = await c.waitUnexpectedResponse();
    expect(status).toBe(401);
    expect(reason).toBe('bad-signature');
  });

  it('an oversized frame is rejected outright — never processed, never truncated', async () => {
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url } = await boot(onFrame);
    const c = await connectNode(url);
    const closed = c.waitClose();

    // Bypasses maxPayload's own accounting shape by sending one huge raw text frame — well over
    // CLUSTER_FRAME_MAX_BYTES (256 KB).
    c.send('x'.repeat(CLUSTER_FRAME_MAX_BYTES + 50_000));

    await closed; // the connection does not survive an oversized frame
    expect(onFrame).not.toHaveBeenCalled(); // never partially parsed/handled
  });

  it('a well-formed frame well under the bound is unaffected by the size guard', async () => {
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url } = await boot(onFrame);
    const c = await connectNode(url);

    c.send({
      type: 'presence',
      protocol: CLUSTER_PROTOCOL,
      capacity: { maxParallel: 1, active: 0, heavyActive: 0, enforcement: 'none' },
      repoDrift: [],
    });
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1));
    c.ws.close();
  });

  it('refuse() sends the reason on the wire, closes the socket, and drops it from connectedNodes()', async () => {
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url, server } = await boot(onFrame);
    const c = await connectNode(url);
    c.send({
      type: 'hello',
      protocol: CLUSTER_PROTOCOL,
      nodeId: NODE_ID,
      nodeName: 'spoke-1',
      version: '0.10.0',
      labels: [],
      watermarks: [],
      projects: [],
    });
    await vi.waitFor(() => expect(server.connectedNodes()).toEqual([NODE_ID]));

    server.refuse(NODE_ID, 'node-disabled', 'revoked by an admin');
    const refuse = await c.next();
    expect(refuse).toMatchObject({ type: 'refuse', reason: 'node-disabled' });
    await vi.waitFor(() => expect(server.connectedNodes()).toEqual([]));
  });

  it('send() to a node with no live socket is false — the hub never queues for an absent node', async () => {
    const { server } = await boot(async () => []);
    expect(server.send('nobody-connected', { type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'workspace', throughHubSeq: 0 })).toBe(
      false,
    );
  });

  it('attaching twice throws', async () => {
    const httpServer = createServer();
    servers.push(httpServer);
    const server = new ClusterLinkServer({ identity: hubIdentity(), lookupSecret: async () => undefined, onFrame: async () => [] });
    hubs.push(server);
    server.attach(httpServer);
    expect(() => server.attach(httpServer)).toThrow(/already attached/);
  });

  // ---- Verification 13 ---------------------------------------------------------------------------
  //
  // "A node-authenticated link socket cannot subscribe to cockpit WS topics, and a browser-origin
  // socket cannot send `ops`." Both halves are tested against THIS server directly: the guard here
  // is what decides admission to the cluster link at all, so a browser-origin caller that cannot
  // even complete the handshake can never reach `ops` — and a node admitted onto this link never
  // has a cockpit-shaped `subscribe` frame treated as anything but an unrecognized, dropped frame.
  // (`server/ws.ts`'s own guard — origin trust, cockpit topics — is exercised in its own
  // ws.test.ts; composing the two real hubs on one shared http.Server currently breaks for a
  // reason that belongs to server/ws.ts, not this file — see this package's final report.)
  describe('Verification 13 — the link and the cockpit bus are separate surfaces', () => {
    it('a browser-origin socket (no node credentials) cannot reach far enough to send ops', async () => {
      const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
      const { url } = await boot(onFrame);
      // Origin header alone is what `server/ws.ts`'s guard trusts — irrelevant here, since this
      // guard never looks at Origin at all (the module doc says so explicitly).
      const c = connectRaw(url, { origin: 'http://127.0.0.1:1' });
      const { status, reason } = await c.waitUnexpectedResponse();
      expect(status).toBe(401);
      expect(reason).toBe('bad-signature');
      // Never admitted, so it structurally cannot have sent `ops` — the handshake itself refused it.
      expect(onFrame).not.toHaveBeenCalled();
    });

    it('a node-authenticated link socket gets no cockpit topic access — a subscribe frame is not a subscription', async () => {
      const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
      const { url } = await boot(onFrame);
      const c = await connectNode(url);

      // Cockpit-shaped, not a ClusterUplinkFrame — must fail schema validation and be dropped,
      // never answered with a cockpit-style `{type:'event', topic, data}`.
      c.send({ type: 'subscribe', topic: 'ticker' });

      // Prove silence rather than absence-of-a-specific-frame: send a real, recognized frame right
      // after, and confirm ONLY that one reaches onFrame (bounding the wait rather than sleeping
      // blindly).
      c.send({
        type: 'presence',
        protocol: CLUSTER_PROTOCOL,
        capacity: { maxParallel: 1, active: 0, heavyActive: 0, enforcement: 'none' },
        repoDrift: [],
      });
      await vi.waitFor(() => expect(onFrame).toHaveBeenCalledTimes(1));
      expect(onFrame).toHaveBeenCalledWith(NODE_ID, expect.objectContaining({ type: 'presence' }));
      c.ws.close();
    });
  });
});
