import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredClusterNodeIdentity } from '@loki-labs/better-cezar-contract';
import { ClusterLinkClient } from './link-client.ts';

/**
 * The silent-upgrade wedge, found 2026-08-23 while wiring package 1.5's activation E2E.
 *
 * Every OTHER failure path in `ClusterLinkClient.dial()` is edge-triggered — `unexpected-response`
 * for an HTTP refusal, `close` for a socket that opens and then dies — and each funnels into
 * `disconnect()` -> `scheduleReconnect()`. An upgrade that gets **no reply at all** fires none of
 * them. Before `handshakeTimeout` was passed to the socket, such an attempt left the client in
 * `connecting` forever: no error, no close, no retry, and a `health()` that read `connecting`
 * rather than `offline`, so no caller could distinguish a permanently wedged link from a slow one.
 *
 * This is reachable in production, and not only during startup. `attachUpgradeFallback` deliberately
 * leaves a socket hanging when it recognizes the path but the real handler has not registered yet
 * ("the hang IS the safer error") — precisely the window between `startServer` returning and
 * `startClusterRuntime`'s `await loadNodeIdentity` resolving. A hub that redeploys often reopens
 * that window on every restart, and the spoke that dials into it never comes back on its own.
 *
 * The server below is that shape reduced to its essentials: it listens, it registers an `upgrade`
 * listener, and that listener does nothing. It never writes a byte and never destroys the socket.
 * Note it must NOT simply omit the listener — Node then answers the upgrade through the ordinary
 * request handler, the client gets `unexpected-response`, and the wedge does not reproduce. The
 * silent listener is what makes this a real negative control rather than a test of the HTTP path.
 */
describe('cluster/link-client — an upgrade that is never answered must not wedge', () => {
  const servers: Server[] = [];
  const clients: ClusterLinkClient[] = [];
  const strandedSockets: Duplex[] = [];

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.stop();
    // The sockets the silent `upgrade` listener deliberately never answers are still open, and
    // `server.close()` waits for open connections — so tearing them down explicitly is required,
    // not tidiness. Without this the hook itself times out, which reads as a client failure and is
    // not one. `closeAllConnections()` alone does not cover a socket already detached by 'upgrade'.
    for (const sock of strandedSockets.splice(0)) sock.destroy();
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });

  async function silentUpgradeHub(): Promise<string> {
    const server = createServer((_req, res) => res.end('ok'));
    server.on('upgrade', (_req, socket) => {
      // Deliberately silent: no write, no destroy. This IS the production behaviour of
      // `attachUpgradeFallback` for a path whose handler has not attached yet. Recorded only so
      // teardown can destroy it — the test itself never touches it.
      strandedSockets.push(socket);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  function spoke(hubUrl: string, handshakeTimeoutMs: number): ClusterLinkClient {
    const identity: StoredClusterNodeIdentity = {
      nodeId: 'spoke-wedge',
      nodeName: 'spoke-wedge',
      createdAt: new Date().toISOString(),
      role: 'spoke',
      hubUrl,
      secret: 'secret-for-the-wedge-test',
      acceptsDispatch: false,
      labels: [],
    };
    const client = new ClusterLinkClient({
      identity,
      hubUrl,
      version: '0.0.0-test',
      handshakeTimeoutMs,
      // Pinned tiny so the assertion is about ESCAPING `connecting`, not about backoff length.
      backoff: { baseMs: 10, maxMs: 20 },
      random: () => 0,
    });
    clients.push(client);
    return client;
  }

  it('gives up on a silent upgrade and schedules a retry, instead of sitting in connecting forever', async () => {
    const hubUrl = await silentUpgradeHub();
    const client = spoke(hubUrl, 150);

    client.start();
    expect(client.health().state).toBe('connecting');

    // Poll rather than sleep a fixed span: the assertion is "it leaves `connecting` on its own",
    // and a fixed sleep would pass just as well against a client that left for the wrong reason.
    const deadline = Date.now() + 4_000;
    while (client.health().state === 'connecting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    const health = client.health();
    // THE assertion that fails without `handshakeTimeout`: pre-fix this is still 'connecting'.
    expect(health.state).not.toBe('connecting');
    expect(health.state).toBe('offline');
    // And it must be a scheduled retry, not a terminal give-up — a wedge that resolves to a dead
    // link is no better than a wedge.
    expect(health.retryAt).toBeTruthy();
  });

  it('negative control: the same hub with a REPLYING upgrade path is not what this test detects', async () => {
    // Guards against the wedge test passing for an uninteresting reason (e.g. any dial failing).
    // Here Node answers the upgrade through the ordinary request handler, so the client learns of
    // the failure through `unexpected-response` — a path that already worked before the fix. If
    // this ever reports 'connecting', the harness itself is broken, not the client.
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const client = spoke(hubUrl, 150);
    client.start();
    const deadline = Date.now() + 4_000;
    while (client.health().state === 'connecting' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(client.health().state).toBe('offline');
  });
});
