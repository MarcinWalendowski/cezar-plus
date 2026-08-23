import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_PROTOCOL, type ClusterPresenceFrame, type StoredClusterNodeIdentity } from '@loki-labs/better-cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { persistNodeCredential } from '../cluster/enrollment.ts';
import { createHubFrameRouter } from '../cluster/hub-router.ts';
import { ClusterLinkClient } from '../cluster/link-client.ts';
import { ClusterLinkServer } from '../cluster/link-server.ts';
import { ensureNodeIdentity } from '../cluster/node-identity.ts';
import { storeNodeSecret } from '../cluster/node-secrets.ts';
import { readPeers, upsertNode } from '../cluster/peers.ts';
import { startClusterRuntime } from './cluster-routes.ts';
import { startServer } from './server.ts';

/**
 * Package 1.5's activation, end to end and for real — no side of this link has ever been driven
 * through a real socket by any other test in this repo (`link-server.test.ts` and
 * `link-client.test.ts` each drive ONE side against a fake/direct call on the other; `hub-router.test.ts`
 * calls the router as a plain function). This file is what proves the wiring `cluster-routes.ts`'s
 * `startClusterRuntime` does — construct the right class for the right role, from the identity on
 * disk, attached to the right server — actually produces two processes that can talk.
 *
 * Three scenarios, in order of how much of `startClusterRuntime` each one exercises:
 *
 *  1. **The hub, for real, through `startServer`** — the harder, more novel half of this package,
 *     since it needed the `server` field added to `ClusterRuntimeDeps` and the call site moved out
 *     of `createApp`. The spoke is a directly-constructed `ClusterLinkClient` (spec's own wording:
 *     "point a real `ClusterLinkClient` at it"), so `.health()` is observable straight off the
 *     instance this test owns — no need to wait on a presence beat's 30s interval to prove the hub
 *     answered `hello` with a `welcome` for real.
 *  2. **The spoke, for real, through `startClusterRuntime`** — the other branch, against a
 *     directly-constructed hub whose own `connectedNodes()` is similarly observable straight off the
 *     instance. Between (1) and (2), every branch `startClusterRuntime` can take is driven through
 *     the real function at least once.
 *  3. **The disposal race** — `stop()` called synchronously, before `loadNodeIdentity`'s `readFile`
 *     resolves, must prevent the link from ever being armed.
 */

const NODE_SECRET = 'a-real-per-node-hmac-secret';

function fakeUpgradeServer() {
  return createServer();
}

function minimalPresenceFrame(overrides?: Partial<ClusterPresenceFrame>): ClusterPresenceFrame {
  return {
    type: 'presence',
    protocol: CLUSTER_PROTOCOL,
    capacity: { maxParallel: 3, active: 1, heavyActive: 0, enforcement: 'none' },
    repoDrift: [],
    ...overrides,
  };
}

describe('cluster link activation (package 1.5) — a real hub and a real spoke can talk', () => {
  const savedCluster = process.env.CEZ_CLUSTER;
  const savedHub = process.env.CEZ_CLUSTER_HUB;
  const savedHome = process.env.CEZ_HOME;
  const dirs: string[] = [];
  const booted: Array<{ close: () => void }> = [];
  const disposers: Array<() => void> = [];
  const stoppableClients: ClusterLinkClient[] = [];

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    delete process.env.CEZ_CLUSTER;
    delete process.env.CEZ_CLUSTER_HUB;
  });

  afterEach(async () => {
    for (const dispose of disposers.splice(0)) dispose();
    for (const client of stoppableClients.splice(0)) await client.stop();
    for (const server of booted.splice(0)) server.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    if (savedCluster === undefined) delete process.env.CEZ_CLUSTER;
    else process.env.CEZ_CLUSTER = savedCluster;
    if (savedHub === undefined) delete process.env.CEZ_CLUSTER_HUB;
    else process.env.CEZ_CLUSTER_HUB = savedHub;
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  describe('1. the hub side, through startServer', () => {
    async function bootHub(): Promise<{ port: number; hubNodeId: string }> {
      const repoRoot = tempDir('cez-cluster-hub-repo-');
      const dataDir = join(repoRoot, '.ai/cezar');
      mkdirSync(dataDir, { recursive: true });
      const store = RunStore.open(dataDir);
      const home = tempDir('cez-cluster-hub-home-');

      process.env.CEZ_HOME = home;
      process.env.CEZ_CLUSTER = '1';
      delete process.env.CEZ_CLUSTER_HUB; // no CEZ_CLUSTER_HUB ⇒ hub, per D1

      const hubIdentity = await ensureNodeIdentity({ role: 'hub' });
      await storeNodeSecret('spoke-1', NODE_SECRET); // D22 store, keyed by the SPOKE's id
      // Roster row for the spoke, so the presence assertion's `markNodeSeen` has something to
      // stamp — `markNodeSeen` never fabricates a row (see its own doc).
      await upsertNode({
        nodeId: 'spoke-1',
        nodeName: 'spoke-1',
        role: 'spoke',
        labels: [],
        acceptsDispatch: false,
        protocol: CLUSTER_PROTOCOL,
        version: '0.0.0-test',
      });

      const server = startServer(
        { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
        0,
      );
      booted.push(server);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      return { port, hubNodeId: hubIdentity.nodeId };
    }

    it('THE TEST THAT MATTERS: a real spoke reaches online against a real, activated hub', async () => {
      const { port } = await bootHub();
      const hubUrl = `http://127.0.0.1:${port}`;

      const spokeIdentity: StoredClusterNodeIdentity = {
        nodeId: 'spoke-1',
        nodeName: 'spoke-1',
        createdAt: new Date().toISOString(),
        role: 'spoke',
        hubUrl,
        secret: NODE_SECRET,
        acceptsDispatch: false,
        labels: [],
      };
      const client = new ClusterLinkClient({ identity: spokeIdentity, hubUrl, version: '0.0.0-test' });
      stoppableClients.push(client);

      // The hub side of this test goes through `startServer` -> `startClusterRuntime`, whose one
      // async step (`await loadNodeIdentity`) means `ClusterLinkServer.attach()` lands a beat AFTER
      // `startServer` has already returned and this server is already `listening` — a real startup
      // race, not a test artifact. It is NOT one the client's own reconnect/backoff (D15b) closes:
      // `ClusterLinkClient` sets no WebSocket `handshakeTimeout`, and Node fires `'upgrade'` once,
      // to whoever is listening at that instant — a listener that registers a beat later never
      // sees a request that already arrived. So an upgrade that lands in that gap gets no response
      // at all (matching `attachUpgradeFallback`'s own doc: "the hang IS the safer error"), and
      // because it never errors or closes, `disconnect()`/`scheduleReconnect()` never fire either —
      // the client just sits in `connecting` forever.
      //
      // **CORRECTED 2026-08-23, same day: that gap is now CLOSED.** This said the wedge was "a real
      // gap in `link-client.ts` (out of this package's file scope; flagged in the implementation
      // report, not fixed here)". The diagnosis above was exactly right and is kept verbatim, but
      // the conclusion is stale: `link-client.ts` now passes `handshakeTimeout` to the socket, so an
      // unanswered upgrade raises `error` then `close`, which reaches `disconnect()` and schedules a
      // retry. See `cluster/link-client-handshake-wedge.test.ts`, which fails with
      // `expected 'connecting' not to be 'connecting'` if that option is removed.
      //
      // The loop below is therefore an ACCELERATOR, not a workaround for an open defect: a single
      // `start()` would now recover on its own, but only after the full handshake timeout plus
      // backoff, which is far longer than this test should take. This
      // loop is the test-side equivalent of what a handshake timeout would give the client for
      // free: give any one attempt a short, bounded window, and if it does not land, tear down that
      // socket and dial a FRESH one — a connection made once `attach()` has actually registered
      // (which every attempt after the first will be, since `loadNodeIdentity`'s disk read finishes
      // in a few ms) is answered immediately, same as scenario 2's directly-built hub.
      const deadline = Date.now() + 10_000;
      for (;;) {
        client.start();
        try {
          await vi.waitFor(() => expect(client.health().state).toBe('online'), { timeout: 300 });
          break;
        } catch (err) {
          await client.stop();
          if (Date.now() > deadline) throw err;
        }
      }

      // The deliverable: the hub's own frame router (`createHubFrameRouter`, wired by
      // `startClusterRuntime`'s hub branch) answered a REAL `hello` sent over a REAL socket with a
      // REAL `welcome` — proven by the CLIENT's own health state, not by a mock standing in for
      // either end.
      expect(client.health().state).toBe('online');

      // Bonus: a presence frame sent over the SAME link lands at the hub and is applied through
      // `markNodeSeen` — the roster row this test seeded above goes from "never seen" to stamped.
      const before = (await readPeers()).nodes.find((n) => n.nodeId === 'spoke-1');
      expect(before?.lastSeenAt).toBeUndefined();
      const sent = client.send(minimalPresenceFrame({ capacity: { maxParallel: 4, active: 2, heavyActive: 1, enforcement: 'none' } }));
      expect(sent).toBe(true);
      await vi.waitFor(async () => {
        const after = (await readPeers()).nodes.find((n) => n.nodeId === 'spoke-1');
        expect(after?.lastSeenAt).toBeTruthy();
        expect(after?.capacity).toEqual({ maxParallel: 4, active: 2, heavyActive: 1, enforcement: 'none' });
      });
    }, 10_000); // headroom over the `waitFor` calls above, for the same startup-race reason as the backoff comment

    it('an identity that disagrees with the environment refuses to guess, and arms nothing — proven behaviourally', async () => {
      // Not a source mutation of `startClusterRuntime` itself — the equivalent, reachable-from-
      // outside case the function's own doc names: an identity on disk that disagrees with what
      // `CEZ_CLUSTER`/`CEZ_CLUSTER_HUB` currently say. Proves the guard actually blocks the link
      // from arming, not merely that it logs something.
      const repoRoot = tempDir('cez-cluster-hub-bad-repo-');
      const dataDir = join(repoRoot, '.ai/cezar');
      mkdirSync(dataDir, { recursive: true });
      const store = RunStore.open(dataDir);
      const home = tempDir('cez-cluster-hub-bad-home-');
      process.env.CEZ_HOME = home;
      process.env.CEZ_CLUSTER = '1';
      delete process.env.CEZ_CLUSTER_HUB; // environment says: this node is the hub
      // ...but the identity on disk says spoke — the mismatch this package's own doc says must
      // refuse rather than silently pick a side.
      await ensureNodeIdentity({ role: 'spoke', hubUrl: 'https://not-really-a-hub.example' });

      const server = startServer(
        {
          repoRoot,
          store,
          manager: { isActive: () => false } as unknown as RunManager,
          version: '0.0.0-test',
        },
        0,
      );
      booted.push(server);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const hubUrl = `http://127.0.0.1:${port}`;
      const client = new ClusterLinkClient({
        identity: { ...spokeIdentityFixture(), hubUrl, nodeId: 'spoke-2' },
        hubUrl,
        version: '0.0.0-test',
        backoff: { baseMs: 20, maxMs: 40 },
      });
      stoppableClients.push(client);
      client.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(client.health().state).not.toBe('online');
    });
  });

  describe('2. the spoke side, through startClusterRuntime', () => {
    it('a real spoke, activated by name, connects to a directly-built hub — connectedNodes() sees it', async () => {
      const spokeHome = tempDir('cez-cluster-spoke-home-');
      await persistNodeCredential(
        { nodeId: 'spoke-1', hubUrl: 'placeholder', secret: NODE_SECRET },
        { env: { CEZ_HOME: spokeHome } },
      );

      // The hub half is built directly here (not through `startClusterRuntime`) so its
      // `connectedNodes()` is observable straight off the instance — the same reasoning as
      // scenario 1's directly-built spoke, applied to the other side.
      const hubIdentity: StoredClusterNodeIdentity = {
        nodeId: 'hub-direct',
        nodeName: 'hub-direct',
        createdAt: new Date().toISOString(),
        role: 'hub',
        acceptsDispatch: false,
        labels: [],
      };
      const hubServer = new ClusterLinkServer({
        identity: hubIdentity,
        onFrame: createHubFrameRouter({ identity: hubIdentity }),
        lookupSecret: async (nodeId) => (nodeId === 'spoke-1' ? NODE_SECRET : undefined),
      });
      const httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      booted.push(httpServer);
      hubServer.attach(httpServer);
      disposers.push(() => void hubServer.close());
      const address = httpServer.address() as AddressInfo;
      const hubUrl = `http://127.0.0.1:${address.port}`;

      // Now re-point the persisted spoke identity at the REAL hub URL — written in the same shape
      // `cez cluster join` writes, so this is the credential `startClusterRuntime` will load.
      await persistNodeCredential({ nodeId: 'spoke-1', hubUrl, secret: NODE_SECRET }, { env: { CEZ_HOME: spokeHome } });

      process.env.CEZ_HOME = spokeHome;
      process.env.CEZ_CLUSTER = '1';
      process.env.CEZ_CLUSTER_HUB = hubUrl; // must agree with the persisted identity's hubUrl

      const stop = startClusterRuntime({ version: '0.0.0-test', server: fakeUpgradeServer() });
      disposers.push(stop);

      await vi.waitFor(() => expect(hubServer.connectedNodes()).toEqual(['spoke-1']), { timeout: 5_000 });
    });
  });

  describe('3. the disposal race', () => {
    it('stop() called synchronously, before loadNodeIdentity resolves, never arms the link', async () => {
      const spokeHome = tempDir('cez-cluster-race-home-');

      const hubIdentity: StoredClusterNodeIdentity = {
        nodeId: 'hub-race',
        nodeName: 'hub-race',
        createdAt: new Date().toISOString(),
        role: 'hub',
        acceptsDispatch: false,
        labels: [],
      };
      const hubServer = new ClusterLinkServer({
        identity: hubIdentity,
        onFrame: createHubFrameRouter({ identity: hubIdentity }),
        lookupSecret: async (nodeId) => (nodeId === 'spoke-1' ? NODE_SECRET : undefined),
      });
      const httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      booted.push(httpServer);
      hubServer.attach(httpServer);
      disposers.push(() => void hubServer.close());
      const address = httpServer.address() as AddressInfo;
      const hubUrl = `http://127.0.0.1:${address.port}`;

      // A real, valid identity on disk — so if the race guard were missing, `loadNodeIdentity`
      // would resolve successfully and the spoke WOULD dial out.
      await persistNodeCredential({ nodeId: 'spoke-1', hubUrl, secret: NODE_SECRET }, { env: { CEZ_HOME: spokeHome } });

      process.env.CEZ_HOME = spokeHome;
      process.env.CEZ_CLUSTER = '1';
      process.env.CEZ_CLUSTER_HUB = hubUrl;

      const stop = startClusterRuntime({ version: '0.0.0-test', server: fakeUpgradeServer() });
      // Synchronous — `loadNodeIdentity`'s `readFile` has not resolved yet; there has been no
      // `await` of any kind since `startClusterRuntime` returned.
      stop();

      // A generous, real wait — long enough for `readFile` to resolve and for a dial that
      // SHOULDN'T happen to have connected if the race guard were missing.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(hubServer.connectedNodes()).toEqual([]);
    });
  });
});

function spokeIdentityFixture(): StoredClusterNodeIdentity {
  return {
    nodeId: 'spoke-x',
    nodeName: 'spoke-x',
    createdAt: new Date().toISOString(),
    role: 'spoke',
    hubUrl: 'https://placeholder.example',
    secret: NODE_SECRET,
    acceptsDispatch: false,
    labels: [],
  };
}
