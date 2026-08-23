import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  type ClusterAckFrame,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterHelloFrame,
  type ClusterOp,
  type ClusterPresenceFrame,
  type ClusterUplinkFrame,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { persistNodeCredential } from '../cluster/enrollment.ts';
import { createHubDispatcher } from '../cluster/hub-dispatch.ts';
import { createHubFrameRouter } from '../cluster/hub-router.ts';
import { ClusterLinkClient } from '../cluster/link-client.ts';
import { ClusterLinkServer } from '../cluster/link-server.ts';
import { ensureNodeIdentity, setAcceptsDispatch } from '../cluster/node-identity.ts';
import { storeNodeSecret } from '../cluster/node-secrets.ts';
import { applyPairingAction, readPeers, upsertNode } from '../cluster/peers.ts';
import type { PlacementCandidate } from '../cluster/placement.ts';
import { createTodo, readTodos } from '../todos.ts';
import { workspaceConfigPath } from '../paths.ts';
import { atomicWriteJsonSync, defaultWorkspaceConfig } from '../workspace/config.ts';
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

  const HUB_E2E_PROJECT_KEY = 'project-hub-e2e';

  describe('1. the hub side, through startServer', () => {
    async function bootHub(): Promise<{ port: number; hubNodeId: string; projectKey: string; dataDir: string }> {
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

      // Registered as this hub's own local project and confirmed-paired BOTH ways with
      // `spoke-1` (D20/D21's two-sided check, `resolveHubTodosRoot`) — what B3's replication
      // path needs to accept an `ops` frame for `HUB_E2E_PROJECT_KEY`. Harmless to the
      // hello/presence scenarios this helper already served before B3: neither reads the
      // project registry or the pairing store.
      const config = {
        ...defaultWorkspaceConfig(),
        projects: [{ id: 'proj-hub-e2e', root: repoRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local' as const }],
      };
      atomicWriteJsonSync(workspaceConfigPath(process.env), config);
      await applyPairingAction(HUB_E2E_PROJECT_KEY, { action: 'confirm', nodeId: hubIdentity.nodeId, projectId: 'proj-hub-e2e' });
      await applyPairingAction(HUB_E2E_PROJECT_KEY, {
        action: 'confirm',
        nodeId: 'spoke-1',
        projectId: 'proj-hub-e2e-spoke-side',
      });

      const server = startServer(
        { repoRoot, store, manager: { isActive: () => false } as unknown as RunManager, version: '0.0.0-test' },
        0,
      );
      booted.push(server);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      return { port, hubNodeId: hubIdentity.nodeId, projectKey: HUB_E2E_PROJECT_KEY, dataDir };
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

    it('B3: a real ops frame is replicated end to end — ack, durable write, replica after the ack', async () => {
      const { port, projectKey, dataDir } = await bootHub();
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

      // Same accelerator loop as "THE TEST THAT MATTERS" above, for the same real startup race —
      // see its comment for the full explanation. Condensed here since the reasoning is not new.
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

      const frames: ClusterDownlinkFrame[] = [];
      client.on('frame', (frame: ClusterDownlinkFrame) => frames.push(frame));

      const op: ClusterOp = {
        opId: 'op-b3-e2e-1',
        nodeId: 'spoke-1',
        ts: new Date().toISOString(),
        scope: 'project',
        projectKey,
        entity: 'todo',
        entityId: 'todo-b3-e2e-1',
        op: 'upsert',
        fields: { summary: 'a real todo from a real socket' },
      };
      const sent = client.send({ type: 'ops', protocol: CLUSTER_PROTOCOL, scope: 'project', projectKey, ops: [op] });
      expect(sent).toBe(true);

      // (1) THE deliverable: a real `ack` frame, over a real socket, for a real op, with the
      // acceptance and the hub-assigned order — never a fabricated or silently-missing reply. This
      // is the assertion the negative control below (deleting `replication` from the wiring at
      // `cluster-routes.ts`'s `createHubFrameRouter({...})` call) must make time out.
      const ack = await vi.waitFor(
        () => {
          const found = frames.find((f): f is ClusterAckFrame => f.type === 'ack');
          expect(found).toBeDefined();
          return found as ClusterAckFrame;
        },
        { timeout: 5_000 },
      );
      expect(ack.results?.[0]?.accepted).toBe(true);
      expect(ack.throughHubSeq).toBe(1);

      // (2) durable on the hub's own disk, not merely acked — the row carries the field values AND
      // the hub-assigned `hubSeq`, not just a count or a bare presence check.
      const rows = await readTodos(dataDir);
      const row = rows.find((r) => r.id === 'todo-b3-e2e-1');
      expect(row?.hubSeq).toBe(1);
      expect(row?.summary).toBe('a real todo from a real socket');

      // (3) the origin's own replica frame rides BEHIND the ack, never ahead of it — `hub-router.ts`
      // returns `[ack, ...originFrames]` deliberately, so the node waiting on its ack gets it first.
      const ackIndex = frames.findIndex((f) => f.type === 'ack');
      const replicaIndex = frames.findIndex((f) => f.type === 'replica');
      expect(replicaIndex).toBeGreaterThan(-1);
      expect(replicaIndex).toBeGreaterThan(ackIndex);
    }, 10_000);

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

      const stop = startClusterRuntime({ version: '0.0.0-test', server: fakeUpgradeServer(), resolveDispatchManager: async () => undefined });
      disposers.push(stop);

      await vi.waitFor(() => expect(hubServer.connectedNodes()).toEqual(['spoke-1']), { timeout: 5_000 });
    });

    /**
     * D38, END TO END ACROSS ALL THREE FILES — the one thing every unit test on this feature is
     * structurally unable to see.
     *
     * The fix is spread over three files owned by three different sessions, and each one is
     * separately, thoroughly unit-tested: `link-client.test.ts` proves the `watermarks` option
     * reaches the wire when a provider is handed in; `spoke-runtime.test.ts` proves
     * `SpokeRuntimeHandle.watermarks()` reports what `projectState` holds. **Neither can prove they
     * are connected to each other**, because both supply their own fake for the other side. The
     * join lives in exactly one place — `cluster-routes.ts`'s
     * `watermarks: () => spokeRuntime?.watermarks() ?? []`, whose `spokeRuntime` is assigned on the
     * line AFTER the client is constructed — and nothing above this test has ever executed it.
     *
     * That gap is this branch's signature failure, four times over: `readTodosFor` sat
     * declared-and-unsupplied while B4 read as done, `prune()` had no production caller for the
     * life of the branch, ~1,500 lines of Milestone B were green with no caller at all — and D38's
     * own `helloWatermarks()` sat fully written and CALLED BY NOBODY for part of 2026-08-23, with
     * `sendHello` still returning the literal `[]` it was built to replace. A well-typed no-op
     * passes every unit test in the repo.
     *
     * **The decisive property is not "hello carries a `watermarks` field" — an unwired provider
     * carries one too, holding `[]`. It is that a SUBSEQUENT hello reports a position the spoke
     * reached after the FIRST one.** Only a reconnect can show it, and only a reconnect without a
     * process restart, which is precisely the case D38 exists for: the hub blue-green deploys ~10
     * times a day, and each one drops every socket while every spoke keeps its in-memory position.
     */
    it('D38: after applying a replica, a RECONNECT reports the position — first hello [], second hello the real watermark', async () => {
      const D38_PROJECT_KEY = 'project-d38-reconnect';
      const spokeHome = tempDir('cez-cluster-d38-home-');
      const spokeRepoRoot = tempDir('cez-cluster-d38-repo-');
      const spokeDataDir = join(spokeRepoRoot, '.ai/cezar');
      mkdirSync(spokeDataDir, { recursive: true });

      // The hub is built directly, for scenario 2's reason (its own state is observable straight
      // off the instance) plus one this test adds: `onFrame` is WRAPPED, so every `hello` that
      // arrives over the real socket is captured. `createHubFrameRouter` is already constructed
      // inline in this file, so the wrap touches no file this test does not own — and it observes
      // the frame the HUB received off the wire, never the object the client built, which is the
      // only reading that can distinguish a live provider from a well-typed no-op.
      const hubIdentity: StoredClusterNodeIdentity = {
        nodeId: 'hub-d38',
        nodeName: 'hub-d38',
        createdAt: new Date().toISOString(),
        role: 'hub',
        acceptsDispatch: false,
        labels: [],
      };
      const router = createHubFrameRouter({ identity: hubIdentity });
      const hellos: ClusterHelloFrame[] = [];
      const hubServer = new ClusterLinkServer({
        identity: hubIdentity,
        onFrame: async (nodeId: string, frame: ClusterUplinkFrame) => {
          // Pushed synchronously, before the first `await` — so a `hello` is always captured by the
          // time `connectedNodes()` can report this node (`link-server.ts` sets `helloReceived`
          // synchronously, in the same call stack, immediately before invoking this).
          if (frame.type === 'hello') hellos.push(frame);
          return router(nodeId, frame);
        },
        lookupSecret: async (nodeId) => (nodeId === 'spoke-1' ? NODE_SECRET : undefined),
      });
      const httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      booted.push(httpServer);
      hubServer.attach(httpServer);
      disposers.push(() => void hubServer.close());
      const hubUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

      process.env.CEZ_HOME = spokeHome;
      process.env.CEZ_CLUSTER = '1';
      process.env.CEZ_CLUSTER_HUB = hubUrl;
      await persistNodeCredential({ nodeId: 'spoke-1', hubUrl, secret: NODE_SECRET }, { env: { CEZ_HOME: spokeHome } });

      // The project has to be REGISTERED on this node and CONFIRMED-paired for it, or
      // `spoke-runtime.ts#discoverOutboxProjects` yields nothing and `applyReplicaDownlink` refuses
      // the push outright ("not a project this node has confirmed pairing for") — no apply, no
      // watermark, and the test would pass its first assertion and prove nothing at the second.
      atomicWriteJsonSync(workspaceConfigPath(process.env), {
        ...defaultWorkspaceConfig(),
        projects: [
          { id: 'proj-d38', root: spokeRepoRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local' as const },
        ],
      });
      await applyPairingAction(D38_PROJECT_KEY, { action: 'confirm', nodeId: 'spoke-1', projectId: 'proj-d38' });

      // The real production path: `startClusterRuntime`'s spoke branch, which is the ONLY place the
      // provider is supplied.
      const stop = startClusterRuntime({ version: '0.0.0-test', server: fakeUpgradeServer(), resolveDispatchManager: async () => undefined });
      disposers.push(stop);

      await vi.waitFor(() => expect(hubServer.connectedNodes()).toEqual(['spoke-1']), { timeout: 5_000 });

      // (1) THE FIRST HELLO IS EMPTY, AND THAT IS CORRECT — DO NOT "FIX" THIS ASSERTION.
      // Nothing has been applied yet, so `[]` is the truthful answer and the full replay the hub
      // sends in response is the correct consequence. A change that makes this line report a
      // position is reasserting a place this node has not been, which is the silent UNDER-send
      // D38's design notes forbid.
      //
      // **This is NOT observing an unwired provider**, though it would look identical if it were.
      // `cluster-routes.ts`'s own comment records the measurement: `start()` -> `dial()` ->
      // `new WebSocket()` returns synchronously and `sendHello` fires from `ws.on('open')`, which
      // needs a network round trip, while `spokeRuntime = stopHeartbeat` runs synchronously two
      // statements later — so no `hello` is ever sent with `spokeRuntime` unassigned. The `?? []`
      // in that provider is a floor, not a window this path passes through. Which is exactly why
      // the assertion that carries this test is the SECOND hello and not this one: an empty first
      // hello is what a live wiring and a dead one both produce.
      expect(hellos).toHaveLength(1);
      expect(hellos[0]?.watermarks).toEqual([]);

      // (2) Drive a REAL replication so the spoke's `appliedThroughHubSeq` actually moves, then
      // force a reconnect and return the `hello` that follows it.
      //
      // The replica goes hub -> spoke over the same live socket, through
      // `spoke-runtime.ts#applyReplicaDownlink` and the real file-backed `todos.ts#applyHubReplica`
      // (no `applyHubReplica` test hook is passed by `startClusterRuntime`, so this is the
      // production write path under its real lease).
      //
      // THE RECONNECT is driven from the hub with `refuse`, deterministically, rather than by
      // sleeping or racing a socket teardown: it writes a `refuse` frame and closes that node's
      // socket (1008). The spoke takes the ordinary reconnect path from there —
      // `link-client.ts`'s message handler calls `ws.close()`, `close` reaches `disconnect()`, and
      // `scheduleReconnect()` re-dials after `nextBackoffMs(0)`, which is under
      // `DEFAULT_LINK_BACKOFF.baseMs` (1s). A bare socket drop (the hub blue-green case, ~10/day)
      // takes the identical path; `refuse` differs only in the health LABEL the spoke renders, and
      // `suppressReconnect` is set for `protocol-major` alone, so `'internal'` reconnects.
      //
      // Crucially the spoke PROCESS never restarts across any of this: `startSpokeRuntime`'s
      // `projectState` map is the same object throughout, which is the whole premise of D38.
      async function replicateThenReconnect(entityId: string, summary: string, hubSeq: number): Promise<ClusterHelloFrame> {
        const helloCountBefore = hellos.length;
        const op: ClusterOp = {
          opId: `op-${entityId}`,
          nodeId: 'hub-d38',
          ts: new Date().toISOString(),
          scope: 'project',
          projectKey: D38_PROJECT_KEY,
          entity: 'todo',
          entityId,
          op: 'upsert',
          fields: { summary },
          hubSeq,
        };
        expect(
          hubServer.send('spoke-1', {
            type: 'replica',
            protocol: CLUSTER_PROTOCOL,
            scope: 'project',
            projectKey: D38_PROJECT_KEY,
            changes: [op],
            hubSeq,
          }),
        ).toBe(true);

        // Independent, durable proof the spoke APPLIED it rather than merely receiving it — the row
        // is on the spoke's own disk. Asserting the watermark alone would let a frame that was
        // parsed and dropped look identical to one that was applied.
        await vi.waitFor(
          async () => {
            const rows = await readTodos(spokeDataDir);
            expect(rows.find((r) => r.id === entityId)?.summary).toBe(summary);
          },
          { timeout: 5_000 },
        );

        hubServer.refuse('spoke-1', 'internal', 'forcing a reconnect for D38');

        return vi.waitFor(
          () => {
            expect(hellos.length).toBeGreaterThan(helloCountBefore);
            return hellos[hellos.length - 1] as ClusterHelloFrame;
          },
          { timeout: 8_000 },
        );
      }

      // (3) THE DELIVERABLE: the second hello names where this node actually is, rather than the
      // `[]` the first one truthfully carried.
      //
      // This is the assertion the three wiring mutations break. Note that all three —
      // `watermarks: () => []`, deleting the option so `helloWatermarks()` takes its
      // `if (!provider) return []` path, and never assigning `spokeRuntime` so `?.` short-circuits
      // — reduce the provider to the SAME constant `[]` function, so they are observationally
      // identical here and everywhere else. They are one property cut at three junctions, not three
      // independent signals; no assertion on the wire can separate them, because the chain has one
      // output and each cut zeroes it.
      const second = await replicateThenReconnect('todo-d38-1', 'replicated to the spoke by the hub', 7);
      expect(second.watermarks).toEqual([
        { scope: 'project', projectKey: D38_PROJECT_KEY, appliedThroughHubSeq: 7, ackedThroughHubSeq: 0 },
      ]);

      // (4) A SECOND reconnect, after the position has moved AGAIN — the one property above that is
      // genuinely separable from "the provider is wired", and the only one a `() => []` mutation
      // cannot also produce.
      //
      // A provider that reads the runtime ONCE and caches passes every assertion above: hello 1 is
      // `[]`, hello 2 reports 7. It is wrong from hello 3 onward, permanently, and in the silent
      // direction — the node claims a position it has since moved past, so the hub replays from
      // there and the gap is never re-sent. `link-client.test.ts` calls this "THE bug. A watermark
      // that is only read once is exactly as useless as a hardcoded `[]`" and covers it against a
      // FAKE runtime; nothing until now covered it across the real three-file chain, where the
      // caching would live in `cluster-routes.ts`'s provider closure.
      //
      // Verified load-bearing by a fourth mutation (memoize the provider's first non-empty result),
      // which leaves (3) green and fails HERE.
      const third = await replicateThenReconnect('todo-d38-2', 'a second replicated row, further along', 12);
      expect(third.watermarks).toEqual([
        { scope: 'project', projectKey: D38_PROJECT_KEY, appliedThroughHubSeq: 12, ackedThroughHubSeq: 0 },
      ]);
    }, 25_000);
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

      const stop = startClusterRuntime({ version: '0.0.0-test', server: fakeUpgradeServer(), resolveDispatchManager: async () => undefined });
      // Synchronous — `loadNodeIdentity`'s `readFile` has not resolved yet; there has been no
      // `await` of any kind since `startClusterRuntime` returned.
      stop();

      // A generous, real wait — long enough for `readFile` to resolve and for a dial that
      // SHOULDN'T happen to have connected if the race guard were missing.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(hubServer.connectedNodes()).toEqual([]);
    });
  });

  /**
   * MILESTONE C, END TO END — the merge gate, and the one test that can see the seam.
   *
   * Milestone C was built as two halves in parallel, meeting at `clusterFreshnessFrameSchema`: the
   * hub places/emits/correlates (`cluster/hub-dispatch.ts`), the spoke decides and runs
   * (`cluster/spoke-runtime.ts`). Each half is separately and thoroughly unit-tested, and **neither
   * suite can prove they are connected**, for a structural reason: the spoke's tests assert what the
   * spoke SENDS, and the hub's tests construct the frames the hub WANTS TO CONSUME. Both supply
   * their own fake for the other side.
   *
   * That is not hypothetical here. While this milestone was being built the hub half added the D48
   * `accepted: { dispatchId, runId }` block and consumed it, and **the spoke half never sent it** —
   * it kept replying with the bare freshness frame. `tsc --noEmit` was EXIT=0 with zero output across
   * both packages, because `accepted` is OPTIONAL and omitting an optional field is not a type error.
   * An optional field at a seam between two owners is the defect that survives every gate either
   * owner can run. This test is what fails on it.
   *
   * **The decisive assertion is not "a reply came back" and not "the reply has an `accepted` block".**
   * It is that the `runId` on the wire equals the id of the run the target's OWN manager minted —
   * which is exactly the confusion `DispatchOutcome.dispatchId`'s docblock calls "silent, and
   * forever": handing a consumer that keys on run id an attempt id instead subscribes it to a run
   * that never existed. A test that accepted any non-empty string would pass against `dispatchId`.
   *
   * **The one substitution, stated rather than buried:** `resolveDispatchManager` returns a recording
   * fake, not a live `RunManager`, because a real `startRun` spawns an agent subprocess and a test
   * must not. Everything else is real — a real socket on a real `node:http` server, the real
   * `startClusterRuntime` spoke branch, the real `createHubDispatcher`, real `placeRun`, a real
   * `todos.json` on disk. So this proves the protocol and the wiring end to end; it does not prove
   * the deploy path, Cloudflare Access admitting the link, or cross-machine behaviour. Those remain
   * ops-gated and must not be reported as covered by this file.
   */
  describe('4. Milestone C — a real dispatch is accepted and a real run starts', () => {
    const C_PROJECT_KEY = 'project-milestone-c';
    const WORKFLOW_DEF = { name: 'dispatch-e2e-workflow', steps: [{ id: 'step-1', prompt: 'do the thing' }], source: 'file' as const };

    interface StartedRun {
      workflow: unknown;
      input: { task: string; author: { via?: string } };
    }

    /** Stands up the whole cluster on loopback: a directly-built hub whose `ClusterLinkServer` this
     *  test owns (so it can dispatch and observe replies straight off the instance, scenario 2's
     *  reason) plus a real spoke through the real `startClusterRuntime` activation path. */
    async function bootCluster(options: { acceptsDispatch: boolean }): Promise<{
      hubServer: ClusterLinkServer;
      dispatcher: ReturnType<typeof createHubDispatcher>;
      replies: ClusterFreshnessFrame[];
      started: StartedRun[];
      todoId: string;
      todoSummary: string;
      mintedRunIds: string[];
    }> {
      const spokeHome = tempDir('cez-cluster-c-home-');
      const spokeRepoRoot = tempDir('cez-cluster-c-repo-');
      const spokeDataDir = join(spokeRepoRoot, '.ai/cezar');
      mkdirSync(spokeDataDir, { recursive: true });

      const hubIdentity: StoredClusterNodeIdentity = {
        nodeId: 'hub-c',
        nodeName: 'hub-c',
        createdAt: new Date().toISOString(),
        role: 'hub',
        acceptsDispatch: false,
        labels: [],
      };
      const router = createHubFrameRouter({ identity: hubIdentity });
      const replies: ClusterFreshnessFrame[] = [];
      let dispatcher!: ReturnType<typeof createHubDispatcher>;
      const hubServer = new ClusterLinkServer({
        identity: hubIdentity,
        onFrame: async (nodeId: string, frame: ClusterUplinkFrame) => {
          // Observed off the WIRE, on the hub, never off the object the spoke built — the only
          // reading that can tell a real send from a well-typed no-op.
          if (frame.type === 'freshness') {
            replies.push(frame);
            dispatcher.recordFreshnessReply(nodeId, frame);
          }
          return router(nodeId, frame);
        },
        lookupSecret: async (nodeId) => (nodeId === 'spoke-1' ? NODE_SECRET : undefined),
      });
      dispatcher = createHubDispatcher({ hubNodeId: hubIdentity.nodeId, linkServer: () => hubServer });

      const httpServer = createServer();
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      booted.push(httpServer);
      hubServer.attach(httpServer);
      disposers.push(() => void hubServer.close());
      const hubUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

      process.env.CEZ_HOME = spokeHome;
      process.env.CEZ_CLUSTER = '1';
      process.env.CEZ_CLUSTER_HUB = hubUrl;
      await persistNodeCredential({ nodeId: 'spoke-1', hubUrl, secret: NODE_SECRET }, { env: { CEZ_HOME: spokeHome } });
      // D11 — the spoke enforces its OWN opt-in regardless of what the hub believes, so this is the
      // switch the refusal case below flips, and nothing on the hub side can substitute for it.
      await setAcceptsDispatch(options.acceptsDispatch, { env: process.env });

      atomicWriteJsonSync(workspaceConfigPath(process.env), {
        ...defaultWorkspaceConfig(),
        projects: [{ id: 'proj-c', root: spokeRepoRoot, name: '', addedAt: '', lastOpenedAt: '', source: 'local' as const }],
      });
      await applyPairingAction(C_PROJECT_KEY, { action: 'confirm', nodeId: 'spoke-1', projectId: 'proj-c' });

      // A REAL todo on the spoke's own disk. The spoke resolves the dispatch's `todoId` against this
      // file and refuses to answer at all if it is not there, so a dispatch for a todo this node has
      // never replicated is a different (also correct) path — not the one under test.
      const todoSummary = 'the dispatched piece of work';
      const todo = await createTodo(spokeDataDir, { summary: todoSummary, status: 'todo' }, { kind: 'user', id: 'local', via: 'cli-todo-add', at: new Date().toISOString() });

      const started: StartedRun[] = [];
      const mintedRunIds: string[] = [];
      let next = 1;
      const fakeManager = {
        hasCapacity: async () => true,
        startRun: (workflow: unknown, input: { task: string; author: { via?: string } }) => {
          // A distinctive id that could not be confused with a `dispatchId` (a UUID) if the two were
          // ever swapped — the swap this test exists to catch would otherwise still look plausible.
          const id = `run-minted-by-the-target-${next++}`;
          mintedRunIds.push(id);
          started.push({ workflow, input });
          return { id };
        },
      } as unknown as RunManager;

      const stop = startClusterRuntime({
        version: '0.0.0-test',
        server: fakeUpgradeServer(),
        resolveDispatchManager: async (repoRoot: string) => (repoRoot === spokeRepoRoot ? fakeManager : undefined),
      });
      disposers.push(stop);
      await vi.waitFor(() => expect(hubServer.connectedNodes()).toEqual(['spoke-1']), { timeout: 5_000 });

      return { hubServer, dispatcher, replies, started, todoId: todo.id, todoSummary, mintedRunIds };
    }

    function candidate(acceptsDispatch: boolean): PlacementCandidate {
      return {
        nodeId: 'spoke-1',
        labels: [],
        acceptsDispatch,
        online: true,
        capacity: { maxParallel: 4, active: 0, heavyActive: 0, enforcement: 'none' },
        holdsProject: true,
      };
    }

    it('THE MERGE GATE: hub dispatches → spoke accepts → a real run starts → the run id comes back and the hub correlates it', async () => {
      const cluster = await bootCluster({ acceptsDispatch: true });

      const attempt = await cluster.dispatcher.dispatch({
        todoId: cluster.todoId,
        request: { projectKey: C_PROJECT_KEY, projectHasOrigin: true },
        candidates: [candidate(true)],
        workflow: { def: WORKFLOW_DEF },
      });

      // (1) The hub placed it REMOTELY and actually put a frame on the wire — `sent: true` is the
      // hub's own report that `ClusterLinkServer.send` found a live socket for that node.
      expect(attempt.placement).toEqual({ status: 'placed', nodeId: 'spoke-1' });
      expect(attempt.dispatch?.sent).toBe(true);
      const dispatchId = attempt.dispatch!.dispatchId;

      // (2) The spoke actually started a run — through the manager THIS project resolves to, with the
      // task text built from the real todo and the author `via` naming the door it came through.
      // What this catches: a `handleDispatch` that answers `accepted` and never calls `startRun`,
      // which is the C-b lie and is invisible to any assertion about the reply alone.
      await vi.waitFor(() => expect(cluster.started).toHaveLength(1), { timeout: 5_000 });
      expect(cluster.started[0]!.input.task).toContain(cluster.todoSummary);
      expect(cluster.started[0]!.input.author.via).toBe('cluster-dispatch');

      // (3) THE SEAM. The reply carries an `accepted` block, and its `runId` is the id the TARGET'S
      // OWN manager minted — not the dispatch id, not any non-empty string. This is the assertion
      // that fails when the spoke replies with the bare frame, which is exactly what it did until
      // this test existed.
      const reply = await vi.waitFor(
        () => {
          const found = cluster.replies.find((f) => f.accepted?.dispatchId === dispatchId);
          expect(found).toBeDefined();
          return found!;
        },
        { timeout: 5_000 },
      );
      expect(reply.accepted?.runId).toBe(cluster.mintedRunIds[0]);
      expect(reply.accepted?.runId).not.toBe(dispatchId);
      expect(reply.refused).toBeUndefined();

      // (4) And the hub's correlation store resolved that attempt, carrying the same run id — C-f's
      // whole point: before this, an accept and a refusal were indistinguishable above the router.
      const record = cluster.dispatcher.get(dispatchId);
      expect(record?.status).toBe('accepted');
      expect(record?.runId).toBe(cluster.mintedRunIds[0]);
      expect(cluster.dispatcher.listPending()).toEqual([]);
    }, 20_000);

    it('D11: a spoke with acceptsDispatch off refuses over the real wire, starts nothing, and the hub records the named reason', async () => {
      const cluster = await bootCluster({ acceptsDispatch: false });

      // The hub is told the node accepts dispatch — deliberately disagreeing with the spoke's own
      // stored opt-in. D11 says the SPOKE is the boundary that enforces, so the hub's belief must not
      // be what decides. Passing `false` here would prove nothing: `placeRun` would filter the node
      // out and no frame would ever reach the spoke, so the spoke's own gate would go unexercised.
      const attempt = await cluster.dispatcher.dispatch({
        todoId: cluster.todoId,
        request: { projectKey: C_PROJECT_KEY, projectHasOrigin: true },
        candidates: [candidate(true)],
        workflow: { def: WORKFLOW_DEF },
      });
      const dispatchId = attempt.dispatch!.dispatchId;

      const reply = await vi.waitFor(
        () => {
          const found = cluster.replies.find((f) => f.refused?.dispatchId === dispatchId);
          expect(found).toBeDefined();
          return found!;
        },
        { timeout: 5_000 },
      );
      expect(reply.refused?.reason).toBe('dispatch-not-accepted');
      expect(reply.accepted).toBeUndefined();
      // The refusal still carries truthful repo-freshness fields — a refusal is the same answer with
      // a reason attached, never a different frame (`clusterFreshnessFrameSchema`'s own doc).
      expect(typeof reply.headSha).toBe('string');
      expect(cluster.started).toEqual([]);

      const record = cluster.dispatcher.get(dispatchId);
      expect(record?.status).toBe('refused');
      expect(record?.refusal?.reason).toBe('dispatch-not-accepted');
    }, 20_000);
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
