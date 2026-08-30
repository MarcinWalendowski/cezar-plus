import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { ClusterLinkHealth, StoredClusterNodeIdentity } from '@loki-labs/cezar-plus-contract';
import { ClusterLinkClient } from './link-client.ts';

/** Fails with a message naming what was awaited, rather than vitest's generic hook timeout — a bare
 *  timeout here reads as "the client is broken" when it may equally be this harness. */
async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const bomb = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${what}`)), ms);
  });
  try {
    return await Promise.race([p, bomb]);
  } finally {
    clearTimeout(timer!);
  }
}

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

    // **CORRECTED 2026-08-23 — subscribe to `health` BEFORE `start()`, and never SAMPLE the state.**
    // This block used to poll `client.health()` every 25ms for 4s and then assert on whatever it
    // happened to see:
    //
    //   ~~const deadline = Date.now() + 4_000;
    //     while (client.health().state === 'connecting' && Date.now() < deadline) {
    //       await new Promise((r) => setTimeout(r, 25));
    //     }~~
    //
    // That passes on a loaded machine and FAILS 5/5 on an idle one, which is the opposite of the
    // usual flake and is why it survived review. The client is not wedged in either case — measured
    // on prod-host, it cycles `connecting` (the 150ms handshake timeout) -> `offline+retryAt`
    // (~10ms) -> `connecting`, at 159 / 314 / 467 / 622 / 775ms. So the state this test wants is true
    // for only ~6% of the time, in a ~10ms window recurring every ~155ms. A 25ms PERIODIC sampler
    // beats against a ~155ms periodic window: on an idle box the cycle is metronome-regular and the
    // sample phase can stay in the 94% for the whole 4s, while a loaded Mac's jitter randomizes the
    // phase and hits almost immediately. The green was the accident, not the red.
    //
    // `setHealth` emits `health` on every transition (`link-client.ts:213`), so observing the EDGE
    // cannot miss a window no matter how narrow it is, and needs no deadline tuning.
    //
    // **An edge-observer trades a missed-WINDOW race for a missed-EDGE race, and it is worth being
    // precise about which one actually protects this test — the honest answer is neither ordering
    // nor a latch.** `EventEmitter` does not replay to a late subscriber, so a listener attached
    // after the transition would hang to the full timeout and read as "the client is wedged" — the
    // exact false diagnosis this file exists to prevent. Measured, though: moving this subscribe
    // BELOW `client.start()` still passes 2/2, because the first non-`connecting` edge is one whole
    // handshake timeout away (150ms) and subscription is synchronous. So the safety margin is that
    // 150ms gap, not the statement order. The order is kept anyway, because it is the only part that
    // stays true if the gap ever shrinks — set `handshakeTimeoutMs` near zero, or make `dial()` emit
    // a non-`connecting` state synchronously, and the margin vanishes while this line still holds.
    // Do not "tidy" it below `start()`.
    const left = new Promise<ClusterLinkHealth>((resolve) => {
      client.on('health', (h: ClusterLinkHealth) => {
        if (h.state !== 'connecting') resolve(h);
      });
    });

    client.start();
    expect(client.health().state).toBe('connecting');

    const health = await withTimeout(left, 4_000, 'client never left `connecting`');
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
