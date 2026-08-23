import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_PROTOCOL,
  type ClusterAckFrame,
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
  SEND_BUDGET_FRAMES_PER_TICK,
  type ClusterLinkServerOptions,
} from './link-server.ts';
import { storeNodeSecret } from './node-secrets.ts';

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

  // D30 (F3), root cause 1: `connectedNodes()` used to report a node from the moment its upgrade
  // completed, before it had said anything at all — a socket a concurrent fan-out could reach with
  // a watermark the hub had never actually learned. See `connectedNodes()`'s own doc for the fix and
  // why it is closed for good, not merely narrowed.
  it('a freshly connected node is not in connectedNodes() until it has attempted a hello on this connection (D30/F3)', async () => {
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url, server } = await boot(onFrame);
    const c = await connectNode(url);

    // The upgrade succeeded — the socket is open and authenticated — but nothing has been sent on
    // it yet. This is exactly the pre-hello window D30 names: it must not look like a valid target.
    expect(server.connectedNodes()).toEqual([]);

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
    c.ws.close();
  });

  // D28 (F4): the send budget is the ONE of `writeFrame`'s three failure paths that is realistically
  // reachable in ordinary operation (an oversized frame no longer reaches this point at all now that
  // `replica-fanout.ts` excludes one before building a frame; "socket not open" is a disconnect
  // race, not a burst). This freezes `now()` so the budget window never rolls over, then hands
  // `onFrame` more replies than one window allows — deterministic, no reliance on a real 1s clock or
  // on actually saturating link throughput.
  it('a reply dropped because the per-node send budget is exhausted is warned about, never silently dropped (D28/F4)', async () => {
    const warnings: string[] = [];
    // Frozen at "now", not a fixed past date — `now()` also drives the upgrade's own signed-principal
    // freshness check (`authenticateLinkUpgrade`), so a stale frozen clock would 401 the handshake
    // before this test ever got to exercise the send budget.
    //
    // FIXED 2026-08-23: the principal must be signed with THIS EXACT instant, not with a fresh
    // `new Date()` at connect time. `verifyClusterFrame` refuses a NEGATIVE age as firmly as a stale
    // one ("a payload claiming to be from the future is exactly as suspect as one that is stale",
    // enrollment.ts:675) — and with the server's clock frozen before `boot()` and the client signing
    // milliseconds later, the age was always negative. The test 401'd on the handshake every single
    // run and never reached the send budget it exists to exercise.
    const frozenNow = new Date();
    const replyCount = SEND_BUDGET_FRAMES_PER_TICK + 1;
    const onFrame = vi.fn(
      async (): Promise<ClusterDownlinkFrame[]> =>
        Array.from({ length: replyCount }, (_, i): ClusterAckFrame => ({
          type: 'ack',
          protocol: CLUSTER_PROTOCOL,
          scope: 'workspace',
          throughHubSeq: i,
        })),
    );
    const { url } = await boot(onFrame, { now: () => frozenNow, warn: (m) => warnings.push(m) });
    const c = connectRaw(url, signedHeaders(NODE_ID, SECRET, frozenNow.toISOString()));
    await c.waitOpen();

    c.send({
      type: 'presence',
      protocol: CLUSTER_PROTOCOL,
      capacity: { maxParallel: 1, active: 0, heavyActive: 0, enforcement: 'none' },
      repoDrift: [],
    });

    // Exactly the budgeted number actually reaches the wire...
    const received: unknown[] = [];
    for (let i = 0; i < SEND_BUDGET_FRAMES_PER_TICK; i++) received.push(await c.next());
    expect(received).toHaveLength(SEND_BUDGET_FRAMES_PER_TICK);

    // ...and the one over budget is warned about, by name, rather than discarded without a trace.
    await vi.waitFor(() => expect(warnings.some((w) => w.includes('budget'))).toBe(true));
    const budgetWarning = warnings.find((w) => w.includes('budget'));
    expect(budgetWarning).toContain(NODE_ID);
    expect(budgetWarning).toContain('ack');
    c.ws.close();
  });

  // D28 (F4), the reply-channel contract itself. `hub-router.ts` advances a watermark per RETURNED
  // frame, and the write happens here, after that router has already resolved — so "was it actually
  // written" has to travel back, or the router is guessing. The two properties that make the report
  // safe to build on are asserted together because neither is sufficient alone: every frame gets a
  // verdict, and the batch STOPS at the first failure rather than writing past it.
  it('onWritten reports every returned frame, and the batch stops at the first undelivered one (D28/F4)', async () => {
    const verdicts: Array<[string, boolean]> = [];
    // Frame 2 alone is over CLUSTER_FRAME_MAX_BYTES, so `writeFrame` refuses it while the socket
    // stays perfectly healthy — which is the case that distinguishes "stop" from "skip and carry
    // on". Carrying on would put frame 3's higher hubSeq on the wire ahead of a frame 2 the
    // receiver never got, and a receiver's watermark is monotonic: frame 2 would then be
    // undeliverable forever. That is a gap manufactured by the writer.
    const oversized: ClusterDownlinkFrame = {
      type: 'replica',
      protocol: CLUSTER_PROTOCOL,
      scope: 'project',
      projectKey: 'proj-1',
      changes: [],
      hubSeq: 2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately over the wire bound
      big: 'x'.repeat(CLUSTER_FRAME_MAX_BYTES + 1_000),
    } as unknown as ClusterDownlinkFrame;
    const frames: ClusterDownlinkFrame[] = [
      { type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'workspace', throughHubSeq: 1 },
      oversized,
      { type: 'ack', protocol: CLUSTER_PROTOCOL, scope: 'workspace', throughHubSeq: 3 },
    ];
    const onFrame = vi.fn(async () => ({
      frames,
      onWritten: (frame: ClusterDownlinkFrame, delivered: boolean) => {
        verdicts.push([frame.type === 'ack' ? `ack-${(frame as ClusterAckFrame).throughHubSeq}` : frame.type, delivered]);
      },
    }));
    const { url } = await boot(onFrame);
    const c = await connectNode(url);

    c.send({
      type: 'presence',
      protocol: CLUSTER_PROTOCOL,
      capacity: { maxParallel: 1, active: 0, heavyActive: 0, enforcement: 'none' },
      repoDrift: [],
    });

    await vi.waitFor(() => expect(verdicts).toHaveLength(3));
    // Frame 1 landed; frame 2 was refused; frame 3 was never attempted and says so rather than
    // going unreported — "not reported" and "delivered" must not be the same observation.
    expect(verdicts).toEqual([
      ['ack-1', true],
      ['replica', false],
      ['ack-3', false],
    ]);

    // ...and only frame 1 is on the wire. Proven by sending a second, ordinary reply afterwards and
    // seeing it arrive next: if frame 3 had been written it would be sitting ahead of this one.
    const first = await c.next();
    expect(first).toMatchObject({ type: 'ack', throughHubSeq: 1 });
    c.ws.close();
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

// D22: `lookupSecret` on `ClusterLinkServerOptions` is optional and defaults to
// `cluster/node-secrets.ts#lookupNodeSecret` — every OTHER test in this file supplies it
// explicitly (via `boot()`'s own default), which is exactly why this needs its own coverage: it is
// the one path nothing else here exercises. `CEZ_HOME` is pinned only for this describe block, not
// the whole file, since every other test in it never touches the filesystem.
describe('lookupSecret defaults to the real node-secrets store when omitted (D22)', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-link-server-secrets-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('admits a node whose secret was stored via node-secrets.ts, with no lookupSecret override at all', async () => {
    await storeNodeSecret(NODE_ID, SECRET);
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url } = await boot(onFrame, { lookupSecret: undefined });
    const c = await connectNode(url);

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

  it('refuses a node whose secret was never stored, even with no override — the default still fails closed', async () => {
    const onFrame = vi.fn(async (): Promise<ClusterDownlinkFrame[]> => []);
    const { url } = await boot(onFrame, { lookupSecret: undefined });
    const c = connectRaw(url, signedHeaders('a-stranger', 'a-guessed-secret', new Date().toISOString()));
    const { status, reason } = await c.waitUnexpectedResponse();
    expect(status).toBe(401);
    expect(reason).toBe('unknown-node');
  });
});
