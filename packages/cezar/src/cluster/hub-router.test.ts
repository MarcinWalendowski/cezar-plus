import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_FRAME_MAX_BYTES,
  CLUSTER_PROTOCOL,
  type ClusterAckFrame,
  type ClusterAckResult,
  type ClusterDownlinkFrame,
  type ClusterFreshnessFrame,
  type ClusterHelloFrame,
  type ClusterNodeId,
  type ClusterOp,
  type ClusterOpScope,
  type ClusterOpsFrame,
  type ClusterPresenceFrame,
  type ClusterRelayFrame,
  type ClusterUplinkFrame,
  type ClusterReplicaFrame,
  type ClusterWelcomeFrame,
  type StoredClusterNode,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { createHubFrameRouter, type HubReplicationDeps } from './hub-router.ts';
import type { ClusterFrameReplies } from './link-server.ts';
import type { HubOpOutcome } from './hub-ops.ts';
import type { TodoItem } from '../todos.ts';
import { applyPairingAction, readPeers, upsertNode } from './peers.ts';

/**
 * Package 1.5 (hub half) of `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md` — the hub-side
 * `onFrame` handler (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, "API contracts").
 * Exercises `peers.ts` for real, against a per-test temp `CEZ_HOME` threaded through
 * `HubFrameRouterDeps#env` — never a mock of the roster store, on `peers.test.ts`'s own precedent.
 */
describe('cluster/hub-router', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-hub-router-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function env(): NodeJS.ProcessEnv {
    return { CEZ_HOME: home };
  }

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

  function makeStoredNode(overrides: Partial<StoredClusterNode> = {}): StoredClusterNode {
    return {
      nodeId: 'node-a',
      nodeName: 'Node A',
      role: 'spoke',
      labels: [],
      acceptsDispatch: false,
      protocol: CLUSTER_PROTOCOL,
      version: '0.10.0',
      ...overrides,
    };
  }

  /**
   * `link-server.ts#onMessage`'s own write loop, reproduced: write each frame in order, report EVERY
   * frame's verdict through `onWritten` (including the ones never attempted after a failure), and
   * stop at the first undelivered one. Deliberately a copy rather than an import — the real loop is
   * a private method on `ClusterLinkServer` and is covered by `link-server.test.ts` against a real
   * socket; what this needs is a driver with the same CONTRACT so a router test can choose which
   * frames land. If the two ever disagree, `link-server.test.ts`'s socket-level cases are the
   * authority, not this.
   *
   * Returns only the frames that were actually written, which is what every assertion in this file
   * means when it says "the reply".
   */
  async function deliverReplies(
    reply: ClusterFrameReplies,
    canDeliver: (frame: ClusterDownlinkFrame) => boolean = () => true,
  ): Promise<ClusterDownlinkFrame[]> {
    const written: ClusterDownlinkFrame[] = [];
    let stopped = false;
    for (const frame of reply.frames) {
      if (stopped) {
        reply.onWritten?.(frame, false);
        continue;
      }
      const delivered = canDeliver(frame);
      reply.onWritten?.(frame, delivered);
      if (delivered) written.push(frame);
      else stopped = true;
    }
    return written;
  }

  /**
   * The router under test, wrapped so a call returns the frames that were DELIVERED — the same thing
   * a node on the other end of a healthy socket would have received. The unwrapped router is on
   * `.raw` for the cases that need to withhold delivery (D28: the watermark must move only for a
   * frame that actually landed), and `.deliver` drives one raw reply with a chosen delivery verdict.
   */
  function router(overrides: { warn?: (m: string) => void; replication?: HubReplicationDeps } = {}) {
    const raw = createHubFrameRouter({
      identity: hubIdentity(),
      env: env(),
      warn: overrides.warn,
      ...(overrides.replication ? { replication: overrides.replication } : {}),
    });
    const wrapped = async (nodeId: ClusterNodeId, frame: ClusterUplinkFrame): Promise<ClusterDownlinkFrame[]> =>
      deliverReplies(await raw(nodeId, frame));
    wrapped.raw = raw;
    wrapped.deliver = deliverReplies;
    return wrapped;
  }

  /**
   * A realistic-enough fake of `HubReplicationDeps` for router-level tests. `allocate` partitions its
   * counter by `(scope, projectKey)` the same way `hub-seq.ts#HubSeqAllocator` does in production
   * (workspace scope ignores any `projectKey`) — this matters for the scope-isolation test below,
   * where two independently-numbered counters both start at hubSeq 1. `findAppliedOp`/`recordAppliedOp`
   * share one in-memory cache, so a retransmitted `opId` is answered from cache rather than re-applied
   * — the idempotence `hub-ops.ts`'s own docblock documents. Everything here is in-memory only; this
   * file never touches the real `hub-seq.ts` or `op-history.ts` (neither is wired into
   * `hub-router.ts`'s callers yet — see the handoff note these tests exist to answer).
   */
  interface FakeReplicationOptions {
    connectedNodes?: () => ClusterNodeId[];
    sendTo?: (nodeId: ClusterNodeId, frame: ClusterDownlinkFrame) => boolean;
    applyOp?: (op: ClusterOp & { hubSeq: number }) => Promise<HubOpOutcome> | HubOpOutcome;
    /** Omitted = replay not wired, which is a distinct, tested state — see the `hello — connect-time
     *  replay (B4)` block's "not wired" case. Returning `undefined` for a project is a REFUSAL and
     *  is not the same as returning `[]`; both are exercised below. */
    readTodosFor?: (
      projectKey: string,
      nodeId: ClusterNodeId,
    ) => Promise<readonly TodoItem[] | undefined>;
  }

  function makeReplication(options: FakeReplicationOptions = {}): HubReplicationDeps {
    const counters = new Map<string, number>();
    const appliedCache = new Map<string, ClusterAckResult>();
    const allocKey = (scope: ClusterOpScope, projectKey?: string): string =>
      scope === 'workspace' ? 'workspace' : `project:${projectKey ?? ''}`;

    return {
      allocate: async ({ scope, projectKey, count }) => {
        const key = allocKey(scope, projectKey);
        const base = counters.get(key) ?? 0;
        const to = base + count;
        counters.set(key, to);
        return { from: base + 1, to };
      },
      applyOp: async (op) => (options.applyOp ? await options.applyOp(op) : { accepted: true }),
      findAppliedOp: async (opId) => appliedCache.get(opId),
      recordAppliedOp: async (opId, result) => {
        appliedCache.set(opId, result);
      },
      sendTo: options.sendTo ?? (() => true),
      connectedNodes: options.connectedNodes ?? (() => []),
      ...(options.readTodosFor ? { readTodosFor: options.readTodosFor } : {}),
    };
  }

  /** A stored todo as `cluster/replay.ts` reads it. `hubSeq` is the whole point — a record without
   *  one has no position in the replicated order and is reported as `unordered` rather than
   *  replayed, which is its own case below. */
  function makeTodo(overrides: Partial<TodoItem> = {}): TodoItem {
    return { id: 't1', summary: 'a todo', ...overrides } as TodoItem;
  }

  function makeOp(opId: string, overrides: Partial<ClusterOp> = {}): ClusterOp {
    return {
      opId,
      nodeId: 'node-a',
      ts: new Date().toISOString(),
      scope: 'project',
      projectKey: 'proj-1',
      entity: 'todo',
      entityId: opId,
      op: 'upsert',
      fields: { status: 'in_progress' },
      ...overrides,
    };
  }

  function opsFrame(ops: ClusterOp[], scope: ClusterOpScope, projectKey?: string): ClusterOpsFrame {
    return {
      type: 'ops',
      protocol: CLUSTER_PROTOCOL,
      scope,
      ...(projectKey !== undefined ? { projectKey } : {}),
      ops,
    };
  }

  function helloFrame(overrides: Partial<ClusterHelloFrame> = {}): ClusterHelloFrame {
    return {
      type: 'hello',
      protocol: CLUSTER_PROTOCOL,
      nodeId: 'node-a',
      nodeName: 'Node A',
      version: '0.10.0',
      labels: [],
      watermarks: [],
      projects: [],
      ...overrides,
    };
  }

  // ---- hello: the identity guard (Verification: mutation-tested, see the session report) -------

  describe('hello — the identity guard', () => {
    it('frame.nodeId matching the AUTHENTICATED nodeId gets a welcome — the positive half', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a' }), { env: env() });
      const replies = await router()('node-a', helloFrame({ nodeId: 'node-a' }));
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({ type: 'welcome', hubNodeId: 'hub-1' });
    });

    it('frame.nodeId DISAGREEING with the authenticated nodeId refuses unknown-node — the negative half', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a' }), { env: env() });
      await upsertNode(makeStoredNode({ nodeId: 'node-b' }), { env: env() });
      const replies = await router()('node-a', helloFrame({ nodeId: 'node-b' }));
      expect(replies).toEqual([
        {
          type: 'refuse',
          protocol: CLUSTER_PROTOCOL,
          reason: 'unknown-node',
          message: 'hello claimed nodeId "node-b", the link authenticated as "node-a"',
        },
      ]);
    });

    // D40b. The frame above refuses the CONTENT; this is what ENDS the link. Separated because they
    // fail independently: a router that returns the right refusal and no `closeAfterWrite` leaves a
    // peer that ignores the frame holding a live socket, and a live socket is a `connectedNodes()`
    // entry, which is a `planReplicaFanout` target. The consequence is measured two describes down
    // ("a FORGED hello reseeds NOTHING").
    it('the refusal also ENDS the link — a refused frame a peer can simply ignore is not enforcement (D40b)', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a' }), { env: env() });
      await upsertNode(makeStoredNode({ nodeId: 'node-b' }), { env: env() });
      const reply = await router().raw('node-a', helloFrame({ nodeId: 'node-b' }));
      expect(Array.isArray(reply)).toBe(false);
      expect((reply as ClusterFrameReplies).closeAfterWrite).toBe('unknown-node');
    });

    // The control for the case above, and it is not decoration: `closeAfterWrite` is an OPTIONAL
    // field, so a router that set it on every hello would satisfy the positive test perfectly while
    // cutting off every healthy spoke in the cluster on its first frame.
    it('a hello that PASSES the identity guard carries no closeAfterWrite — the link survives being welcomed', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a' }), { env: env() });
      const reply = await router().raw('node-a', helloFrame({ nodeId: 'node-a' }));
      const closeAfterWrite = Array.isArray(reply) ? undefined : (reply as ClusterFrameReplies).closeAfterWrite;
      expect(closeAfterWrite).toBeUndefined();
    });
  });

  // ---- hello: the welcome shape -----------------------------------------------------------------

  describe('hello — welcome shape', () => {
    it('an empty roster/pairing store still gets a welcome, not an error', async () => {
      const replies = await router()('node-a', helloFrame());
      expect(replies).toEqual([
        {
          type: 'welcome',
          protocol: CLUSTER_PROTOCOL,
          hubNodeId: 'hub-1',
          roster: [],
          pairings: [],
          resumeFrom: [],
        },
      ]);
    });

    it('roster and pairings are the mapped, CURRENT peers.json contents — not an echo of the hello', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a', nodeName: 'Node A' }), { env: env() });
      await upsertNode(makeStoredNode({ nodeId: 'node-b', nodeName: 'Node B', role: 'hub' }), { env: env() });
      await applyPairingAction('pk-1', { action: 'confirm', nodeId: 'node-a', projectId: 'proj-a' }, { env: env() });

      const replies = await router()('node-a', helloFrame({ nodeId: 'node-a' }));
      const welcome = replies[0];
      if (welcome?.type !== 'welcome') throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);

      expect(welcome.roster.map((n) => n.nodeId).sort()).toEqual(['node-a', 'node-b']);
      expect(welcome.pairings).toEqual([
        {
          projectKey: 'pk-1',
          byNode: { 'node-a': { nodeId: 'node-a', projectId: 'proj-a', confirmedAt: expect.any(String) } },
        },
      ]);
      expect(welcome.resumeFrom).toEqual([]);
      // Deliberately OMITTED, not sent as `[]` — see the module docblock on why this router has no
      // cross-node advert store to compute a proposal from yet.
      expect(welcome.proposals).toBeUndefined();
    });

    it('the welcome roster is the FULL mapped wire shape, not just ids — and drops stored-only extras', async () => {
      /*
       * **Added 2026-08-23 (B5), and found by mutation rather than by reading.** `welcome.pairings`
       * was already asserted exhaustively with `toEqual` above, but `roster` was only ever checked
       * for `nodeId` — so every other field `toNodeWire` maps was unpinned ON THIS SIDE. Proof it
       * was a real gap and not a theoretical one: deleting `version:` from the shared mapper left
       * this entire file green, and reddened only `server/cluster-link-activation.test.ts`. The hub
       * half of the same mapping had no field-level coverage at all.
       *
       * `toEqual` rather than `objectContaining` is the point: it fails BOTH ways — on a field the
       * mapper stops emitting, AND on a stored-only key that leaks onto the wire. The second is why
       * `secretHash` is seeded below.
       *
       * **EVERY optional is populated, and that is load-bearing rather than thorough.** The mapper
       * carries fourteen fields, six of them as `...(x !== undefined ? { x } : {})`. A fixture that
       * leaves one absent CANNOT pin its line: the field is missing from the output whether the
       * spread is there or not, so deleting it stays green. An exhaustive-looking `toEqual` over a
       * sparse fixture pins only the fields the fixture happens to set — which was this test's own
       * first version, covering 8 of 14. `storedClusterNodeSchema` is `.passthrough()`, so an unknown
       * key really does survive `upsertNode`'s parse into peers.json, while `clusterNodeSchema` is
       * `.strict()` — and the ONLY thing standing between them is `toNodeWire` rebuilding the object
       * field-by-field. Nothing else would catch a spread creeping in.
       */
      const capacity = {
        maxParallel: 4,
        active: 1,
        maxHeavySteps: 2,
        heavyActive: 0,
        enforcement: 'cgroup',
      } as const;
      const hostMetrics = {
        cpuPercent: 12.5,
        memoryPercent: 41,
        cpuCount: 8,
        memoryUsedBytes: 1_000,
        memoryTotalBytes: 4_000,
        sampledAt: 1_724_400_000_000,
      } as const;
      const repoDrift = [
        { projectKey: 'pk-1', headSha: 'abc123', ahead: 1, behind: 2, dirty: 3, merging: false },
      ] as const;
      const corpus = {
        version: '7',
        fetchedAt: '2026-08-23T00:00:00.000Z',
        scope: ['knowledge'],
        quarantined: 0,
      } as const;

      await upsertNode(
        {
          ...makeStoredNode({
            nodeId: 'node-a',
            disabledAt: '2026-08-23T00:00:00.000Z',
            // EVERY optional the mapper carries, populated — see the note above on why an absent
            // field cannot pin its own spread line.
            lastSeenAt: '2026-08-22T00:00:00.000Z',
            capacity,
            capacityAt: '2026-08-22T00:00:01.000Z',
            hostMetrics,
            repoDrift: [...repoDrift],
            corpus: { ...corpus, scope: [...corpus.scope] },
          }),
          secretHash: 'stored-only — must never reach the wire',
        } as StoredClusterNode,
        { env: env() },
      );

      const replies = await router()('node-a', helloFrame({ nodeId: 'node-a' }));
      const welcome = replies[0];
      if (welcome?.type !== 'welcome') throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);

      expect(welcome.roster).toEqual([
        {
          nodeId: 'node-a',
          nodeName: 'Node A',
          role: 'spoke',
          labels: [],
          acceptsDispatch: false,
          protocol: CLUSTER_PROTOCOL,
          version: '0.10.0',
          lastSeenAt: '2026-08-22T00:00:00.000Z',
          capacity,
          capacityAt: '2026-08-22T00:00:01.000Z',
          hostMetrics,
          repoDrift,
          corpus,
          disabledAt: '2026-08-23T00:00:00.000Z',
        },
      ]);
    });

    it('does not itself gate on a roster row with disabledAt set — the UPGRADE already refused before onFrame could run (D22)', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a', disabledAt: new Date().toISOString() }), { env: env() });
      const replies = await router()('node-a', helloFrame({ nodeId: 'node-a' }));
      expect(replies[0]?.type).toBe('welcome');
    });
  });

  // ---- hello: connect-time replay (B4) ----------------------------------------------------------
  //
  // Milestone B's largest hole until 2026-08-23: a spoke offline when a batch landed never received
  // it and never would — `resumeFrom` was hardcoded `[]` and nothing shipped what a node had missed.
  // `cluster/replay.ts` (Design B, scan present state) is the engine; this is its ONLY production
  // caller, so every case here is also the proof that engine is reachable at all.
  describe('hello — connect-time replay (B4)', () => {
    /**
     * The roster half of every fixture here, and NOT boilerplate: `hello` enumerates its replay
     * candidates from `peers.json`, never from the frame, so a project with no pairing row
     * mentioning this node is never even asked about. Each test that expects a replay must pair
     * first — which makes the pairing call itself the assertion that enumeration is roster-driven,
     * and makes its absence the fixture for a node that has advertised nothing.
     */
    async function pairWith(nodeId: ClusterNodeId, ...projectKeys: string[]): Promise<void> {
      for (const projectKey of projectKeys) {
        await applyPairingAction(projectKey, { action: 'confirm', nodeId, projectId: `id-${projectKey}` }, { env: env() });
      }
    }

    /** `todosByProject` IS the `readTodosFor` authority: a key PRESENT maps to whatever records that
     *  project holds (possibly none), and a key ABSENT is the dep's `undefined` — a refusal. The two
     *  are different answers and are tested as such; `Record`'s missing-key `undefined` is exactly
     *  the shape the real dep returns when `resolveHubTodosRoot` refuses. */
    function replayReplication(
      todosByProject: Record<string, readonly TodoItem[]>,
      options: FakeReplicationOptions = {},
    ): HubReplicationDeps {
      return makeReplication({ ...options, readTodosFor: async (projectKey) => todosByProject[projectKey] });
    }

    it('ships what the node has not applied as replica frames BEHIND the welcome, and resumeFrom states where each scope resumed from', async () => {
      await pairWith('node-a', 'proj-1');
      const replication = replayReplication({
        'proj-1': [makeTodo({ id: 't1', hubSeq: 1 }), makeTodo({ id: 't2', hubSeq: 2 })],
      });

      const replies = await router({ replication })('node-a', helloFrame({ nodeId: 'node-a' }));

      // The welcome is still first — a replay that arrived ahead of the handshake reply would be a
      // different, unannounced protocol.
      expect(replies[0]?.type).toBe('welcome');
      const welcome = replies[0] as ClusterWelcomeFrame;
      expect(welcome.resumeFrom).toEqual([
        { scope: 'project', projectKey: 'proj-1', appliedThroughHubSeq: 0, ackedThroughHubSeq: 0 },
      ]);

      // ...and the catch-up rides immediately behind it, in hub order.
      expect(replies).toHaveLength(2);
      const replay = replies[1] as ClusterReplicaFrame;
      expect(replay.type).toBe('replica');
      expect(replay.changes.map((c) => c.entityId)).toEqual(['t1', 't2']);
      expect(replay.hubSeq).toBe(2);
    });

    it('replays only what is ABOVE the position the node reported, and echoes its own ackedThroughHubSeq back unchanged', async () => {
      await pairWith('node-a', 'proj-1');
      const replication = replayReplication({
        'proj-1': [makeTodo({ id: 't1', hubSeq: 1 }), makeTodo({ id: 't2', hubSeq: 2 })],
      });

      const replies = await router({ replication })(
        'node-a',
        helloFrame({
          nodeId: 'node-a',
          watermarks: [{ scope: 'project', projectKey: 'proj-1', appliedThroughHubSeq: 1, ackedThroughHubSeq: 7 }],
        }),
      );

      const welcome = replies[0] as ClusterWelcomeFrame;
      // `ackedThroughHubSeq` is a fact about the node's OWN outbox that the hub does not track, so it
      // is echoed, never recomputed — a fabricated 0 here would be a hub opinion in a field that
      // means "what you told me".
      expect(welcome.resumeFrom).toEqual([
        { scope: 'project', projectKey: 'proj-1', appliedThroughHubSeq: 1, ackedThroughHubSeq: 7 },
      ]);
      const replay = replies[1] as ClusterReplicaFrame;
      expect(replay.changes.map((c) => c.entityId)).toEqual(['t2']); // never t1
    });

    it('a scope the node is already caught up on produces a welcome and NOTHING else — never an empty replica frame', async () => {
      await pairWith('node-a', 'proj-1');
      const replication = replayReplication({ 'proj-1': [makeTodo({ id: 't1', hubSeq: 1 })] });
      const replies = await router({ replication })(
        'node-a',
        helloFrame({
          nodeId: 'node-a',
          watermarks: [{ scope: 'project', projectKey: 'proj-1', appliedThroughHubSeq: 1, ackedThroughHubSeq: 0 }],
        }),
      );
      expect(replies).toHaveLength(1);
      expect(replies[0]?.type).toBe('welcome');
    });

    // ---- the refusal / empty distinction ------------------------------------------------------
    //
    // `readTodosFor` returns `undefined` for a project this node may not be replayed (D21 needs the
    // pairing confirmed BOTH ways plus a projectId the hub's registry still resolves) and `[]` for
    // one it may be replayed that simply has no records. Those are different answers and the hub
    // must not collapse them: `[]` earns a `resumeFrom` entry saying "you are at 0 and caught up",
    // and a refusal must NOT, because that entry would assert a pairing the hub is refusing.

    it('a REFUSED project gets no resumeFrom entry at all, and the node is still welcomed normally', async () => {
      const warnings: string[] = [];
      // Paired in the roster — so it IS a candidate and IS asked about — and refused by the dep.
      await pairWith('node-a', 'proj-refused');
      const asked: string[] = [];
      const replication = makeReplication({
        readTodosFor: async (projectKey, askedFor) => {
          // BOTH arguments, because the second one is the whole authorization. `readTodosFor`
          // resolves the entitlement of the node it is given, so handing it the hub's own id (or
          // any other node's) would answer a remote node's hello with a project it is not paired
          // on — a privilege escalation that a projectKey-only assertion here could not see.
          asked.push(`${askedFor}/${projectKey}`);
          return undefined;
        },
      });

      const replies = await router({ replication, warn: (m) => warnings.push(m) })(
        'node-a',
        helloFrame({ nodeId: 'node-a' }),
      );

      expect(asked).toEqual(['node-a/proj-refused']); // the refusal came from the dep, not from a filter here
      // A refusal is refused per PROJECT, never by tearing down the link: a `refuse` frame ends the
      // whole session, and one unconfirmed project must not cost a node every other project it is
      // legitimately paired on. Same shape as the forged-author guard below — refuse the op, keep
      // the frame.
      expect(replies).toHaveLength(1);
      expect(replies[0]?.type).toBe('welcome');
      expect((replies[0] as ClusterWelcomeFrame).resumeFrom).toEqual([]);

      const refusal = warnings.find((w) => w.includes('REPLAY-REFUSED'));
      expect(refusal).toBeDefined();
      expect(refusal).toContain('proj-refused');
      expect(refusal).toContain('node-a');
    });

    it('an ENTITLED but EMPTY project DOES get a resumeFrom entry — "caught up at 0" is a different answer from "refused"', async () => {
      await pairWith('node-a', 'proj-empty');
      const replication = replayReplication({ 'proj-empty': [] });

      const replies = await router({ replication })('node-a', helloFrame({ nodeId: 'node-a' }));

      expect(replies).toHaveLength(1); // nothing to replay — never an empty replica frame
      // This entry is the ONLY thing on the wire that distinguishes this case from the refusal
      // above, where the node sees the same welcome with an empty resumeFrom.
      expect((replies[0] as ClusterWelcomeFrame).resumeFrom).toEqual([
        { scope: 'project', projectKey: 'proj-empty', appliedThroughHubSeq: 0, ackedThroughHubSeq: 0 },
      ]);
    });

    // ---- which projects get enumerated --------------------------------------------------------
    //
    // The hub's roster, never the node's claim about itself. A NEWLY PAIRED node is the case the
    // milestone exists to serve and it advertises NOTHING about the project — it has never seen it
    // — so an enumeration driven by `frame.watermarks` or `frame.projects` would skip exactly the
    // node that needs the full copy. (Both fields are also hardcoded `[]` by the real
    // `ClusterLinkClient#sendHello` today, so such an enumeration would ship nothing, forever,
    // while looking implemented.)

    it('a newly paired node that advertises NOTHING is still replayed the whole project from 0', async () => {
      await pairWith('node-a', 'proj-new');
      const replication = replayReplication({
        'proj-new': [makeTodo({ id: 't1', hubSeq: 1 }), makeTodo({ id: 't2', hubSeq: 2 })],
      });

      // The real client's frame: no watermarks, no project adverts, nothing to enumerate from.
      const replies = await router({ replication })(
        'node-a',
        helloFrame({ nodeId: 'node-a', watermarks: [], projects: [] }),
      );

      expect((replies[0] as ClusterWelcomeFrame).resumeFrom).toEqual([
        { scope: 'project', projectKey: 'proj-new', appliedThroughHubSeq: 0, ackedThroughHubSeq: 0 },
      ]);
      expect((replies[1] as ClusterReplicaFrame | undefined)?.changes.map((c) => c.entityId)).toEqual(['t1', 't2']);
    });

    it('a project the node ADVERTISES but the roster does not pair it on is never even asked about', async () => {
      await pairWith('node-a', 'proj-paired');
      // A pairing on the same hub that does NOT mention node-a. Without it, "candidates are the
      // pairings mentioning this node" and "candidates are every pairing" are indistinguishable,
      // and the enumeration filter could be deleted with this file still green.
      await pairWith('node-b', 'proj-someone-else');
      const asked: string[] = [];
      const replication = makeReplication({
        readTodosFor: async (projectKey, askedFor) => {
          asked.push(`${askedFor}/${projectKey}`);
          return [makeTodo({ id: `${projectKey}-t1`, hubSeq: 1 })];
        },
      });

      const replies = await router({ replication })(
        'node-a',
        helloFrame({
          nodeId: 'node-a',
          // The node asserting an entitlement it does not have — the same class of frame-body claim
          // the forged-author guard refuses. Enumerating from here would make `readTodosFor` the
          // only thing standing between a node's own assertion and a project's contents.
          watermarks: [{ scope: 'project', projectKey: 'proj-claimed', appliedThroughHubSeq: 0, ackedThroughHubSeq: 0 }],
          projects: [
            { projectId: 'id-proj-claimed', projectKey: 'proj-claimed', slug: 'claimed', basename: 'claimed', ownGitCommonDir: true },
          ],
        }),
      );

      expect(asked).toEqual(['node-a/proj-paired']); // never 'proj-claimed', never node-b's pairing
      expect((replies[0] as ClusterWelcomeFrame).resumeFrom.map((w) => w.projectKey)).toEqual(['proj-paired']);
    });

    it('records with no hubSeq are REPORTED as unordered, never replayed as if the hub had ordered them', async () => {
      const warnings: string[] = [];
      await pairWith('node-a', 'proj-1');
      const replication = replayReplication({
        'proj-1': [makeTodo({ id: 'ordered', hubSeq: 1 }), makeTodo({ id: 'never-replicated' })],
      });

      const replies = await router({ replication, warn: (m) => warnings.push(m) })(
        'node-a',
        helloFrame({ nodeId: 'node-a' }),
      );

      const replay = replies[1] as ClusterReplicaFrame;
      expect(replay.changes.map((c) => c.entityId)).toEqual(['ordered']); // never 'never-replicated'

      // `unordered` is non-optional on the scan's result precisely so a caller cannot drop it by
      // destructuring only `{ plans }`. This asserts the caller does not drop it anyway.
      const unorderedWarning = warnings.find((w) => w.includes('REPLAY-UNORDERED'));
      expect(unorderedWarning).toBeDefined();
      expect(unorderedWarning).toContain('never-replicated');
      expect(unorderedWarning).toContain('1 of 2 record(s)');
      expect(unorderedWarning).toContain('node-a');
    });

    it('an oversized record is REPORTED as excluded and the rest of the scope still replays', async () => {
      const warnings: string[] = [];
      await pairWith('node-a', 'proj-1');
      const replication = replayReplication({
        'proj-1': [
          makeTodo({ id: 'huge', hubSeq: 1, summary: 'x'.repeat(CLUSTER_FRAME_MAX_BYTES + 1_000) }),
          makeTodo({ id: 'normal', hubSeq: 2 }),
        ],
      });

      const replies = await router({ replication, warn: (m) => warnings.push(m) })(
        'node-a',
        helloFrame({ nodeId: 'node-a' }),
      );

      const replay = replies[1] as ClusterReplicaFrame;
      expect(replay.changes.map((c) => c.entityId)).toEqual(['normal']);
      const excludedWarning = warnings.find((w) => w.includes('REPLAY-EXCLUDED'));
      expect(excludedWarning).toBeDefined();
      expect(excludedWarning).toContain('huge');
    });

    it('replication wired but readTodosFor ABSENT says so out loud and keeps resumeFrom [] — the state must not read as "you are caught up"', async () => {
      const warnings: string[] = [];
      // Paired, so the ONLY reason nothing is replayed is the missing dep — without this the test
      // would pass on an unpaired node too, and could not tell "not wired" from "nothing to send".
      await pairWith('node-a', 'proj-1');
      const replication = makeReplication({ connectedNodes: () => ['node-a'] });
      const replies = await router({ replication, warn: (m) => warnings.push(m) })(
        'node-a',
        helloFrame({ nodeId: 'node-a' }),
      );

      expect(replies).toHaveLength(1);
      expect((replies[0] as ClusterWelcomeFrame).resumeFrom).toEqual([]);
      const warning = warnings.find((w) => w.includes('no connect-time replay wired'));
      expect(warning).toBeDefined();
      expect(warning).toContain('node-a');
      expect(warning).toContain('readTodosFor');
    });

    it('more scopes than clusterWelcomeFrameSchema can carry sends an EMPTY resumeFrom, never a truncated one, and still sends the replica frames', async () => {
      const warnings: string[] = [];
      // 501 scopes — one over the schema's `.max(500)`. Unreachable on today's workspaces (12
      // projects on the production box) and deliberately still handled: a truncated `resumeFrom`
      // that a spoke reads as complete is the same silent-loss bug this whole field was kept honest
      // to avoid, so the honest answer is the one that already means "this hub cannot replay".
      const keys = Array.from({ length: 501 }, (_, i) => `proj-${i}`);
      await pairWith('node-a', ...keys);
      const replication = replayReplication(
        Object.fromEntries(keys.map((key, i) => [key, i === 0 ? [makeTodo({ id: 't1', hubSeq: 1 })] : []])),
      );

      const replies = await router({ replication, warn: (m) => warnings.push(m) })(
        'node-a',
        helloFrame({ nodeId: 'node-a' }),
      );

      expect((replies[0] as ClusterWelcomeFrame).resumeFrom).toEqual([]);
      // The catch-up itself is unaffected — it rides in separate frames, not in `resumeFrom`.
      expect((replies[1] as ClusterReplicaFrame | undefined)?.changes.map((c) => c.entityId)).toEqual(['t1']);
      expect(warnings.some((w) => w.includes('501 replay scopes') && w.includes('truncated'))).toBe(true);
    });

    // D30, root cause 3. `seedWatermark` only ever overwrote the keys a hello MENTIONED, and a real
    // hello mentions none at all (`ClusterLinkClient#sendHello` hardcodes `watermarks: []`), so a
    // watermark the hub advanced in a previous session survived every reconnect with nothing able to
    // correct it. Here the hub genuinely advances node-a to hubSeq 1 by pushing it a live replica,
    // node-a then reconnects reporting nothing, and the replay must start from 0 again.
    it('a hello DELETES everything remembered for that node before seeding — a watermark the frame does not mention is not carried over (D30)', async () => {
      await pairWith('node-a', 'proj-1');
      const replication = replayReplication({ 'proj-1': [makeTodo({ id: 't1', hubSeq: 1 })] }, {
        connectedNodes: () => ['node-a', 'node-b'],
      });
      const r = router({ replication });

      // node-b writes; node-a is pushed the replica, so the hub now believes node-a is at hubSeq 1.
      await r('node-b', opsFrame([makeOp('op-1', { entityId: 't1', nodeId: 'node-b' })], 'project', 'proj-1'));

      // node-a reconnects and mentions NO watermarks — the real client's shape.
      const replies = await r('node-a', helloFrame({ nodeId: 'node-a', watermarks: [] }));

      const welcome = replies[0] as ClusterWelcomeFrame;
      expect(welcome.resumeFrom).toEqual([
        { scope: 'project', projectKey: 'proj-1', appliedThroughHubSeq: 0, ackedThroughHubSeq: 0 },
      ]);
      expect((replies[1] as ClusterReplicaFrame | undefined)?.changes.map((c) => c.entityId)).toEqual(['t1']);
    });

    // D30, F3's ordering half. A replayed row carries the record's OWN stored hubSeq, which is below
    // whatever the hub is allocating right now. A receiver's watermark is monotonic and drops
    // anything at or below it, so a live frame that overtakes an in-flight replay makes the whole
    // replay land as a no-op. The node is therefore held out of live fan-out from the moment its
    // hello starts until its replay frames have been WRITTEN.
    it('a node whose replay is in flight is not a live fan-out target, and becomes one again once its replay frames are written (D30/F3)', async () => {
      const pushedToA: ClusterReplicaFrame[] = [];
      // hubSeq 1, not an arbitrarily high number: a replayed record's own stored hubSeq is by
      // construction BELOW what the hub is allocating now, and a fixture that inverted that would
      // make the final assertion pass or fail for the wrong reason (a watermark above every future
      // allocation filters everything, hold or no hold).
      await pairWith('node-a', 'proj-1');
      const replication = replayReplication({ 'proj-1': [makeTodo({ id: 't1', hubSeq: 1 })] }, {
        connectedNodes: () => ['node-a', 'node-b'],
        sendTo: (nodeId, frame) => {
          if (nodeId === 'node-a') pushedToA.push(frame as ClusterReplicaFrame);
          return true;
        },
      });
      const r = router({ replication });

      // The hello is handled, but its replies are NOT yet written — exactly the window in which
      // `link-server.ts` has resolved `onFrame` and has not yet run its write loop, and in which a
      // concurrently-handled `ops` frame from another node can call `sendTo`.
      const helloReply = await r.raw('node-a', helloFrame({ nodeId: 'node-a' }));
      expect(helloReply.frames.map((f) => f.type)).toEqual(['welcome', 'replica']);

      await r('node-b', opsFrame([makeOp('op-mid', { entityId: 'mid', nodeId: 'node-b' })], 'project', 'proj-1'));
      expect(pushedToA).toEqual([]); // held — nothing overtakes the replay

      // PARTIAL write: the welcome has gone out, the replay frame behind it has NOT. The hold must
      // survive this, and this step is the only thing in the file that can tell "released once every
      // frame has a verdict" apart from "released on the first one" — without it, releasing early
      // is indistinguishable from releasing correctly, because nothing else observes the gap.
      helloReply.onWritten?.(helloReply.frames[0]!, true);
      await r('node-b', opsFrame([makeOp('op-mid2', { entityId: 'mid2', nodeId: 'node-b' })], 'project', 'proj-1'));
      expect(pushedToA).toEqual([]); // STILL held — the replay itself is not on the wire yet

      // The replay frame lands, the hold is released...
      helloReply.onWritten?.(helloReply.frames[1]!, true);

      // ...and the very next batch reaches node-a normally.
      await r('node-b', opsFrame([makeOp('op-after', { entityId: 'after', nodeId: 'node-b' })], 'project', 'proj-1'));
      expect(pushedToA.map((f) => f.changes.map((c) => c.entityId))).toEqual([['after']]);
    });

    // The replay's own D28: a replay frame's watermark advance is a claim about DELIVERY, and the
    // write happens in `link-server.ts` after this router has returned. Discriminated through a
    // RETRANSMIT, which is the one live path that can carry a hubSeq at or below an existing
    // watermark (`op-history` answers a repeated opId with the same hubSeq it already assigned).
    it('a replay frame advances the node\'s watermark only when the write is CONFIRMED — positive control included', async () => {
      async function runScenario(replayDelivered: boolean): Promise<ClusterReplicaFrame[]> {
        await pairWith('node-a', 'proj-1');
        const pushedToA: ClusterReplicaFrame[] = [];
        let connected: ClusterNodeId[] = ['node-b'];
        const replication = replayReplication({ 'proj-1': [makeTodo({ id: 't-x', hubSeq: 1 })] }, {
          connectedNodes: () => connected,
          sendTo: (nodeId, frame) => {
            if (nodeId === 'node-a') pushedToA.push(frame as ClusterReplicaFrame);
            return true;
          },
        });
        const r = router({ replication });
        const op = makeOp('op-x', { entityId: 't-x', nodeId: 'node-b' });

        // node-b writes while node-a is offline — hubSeq 1, no push to node-a.
        await r('node-b', opsFrame([op], 'project', 'proj-1'));
        expect(pushedToA).toEqual([]);

        // node-a reconnects; the replay carries exactly that record, at hubSeq 1.
        connected = ['node-a', 'node-b'];
        const helloReply = await r.raw('node-a', helloFrame({ nodeId: 'node-a' }));
        expect(helloReply.frames.filter((f) => f.type === 'replica')).toHaveLength(1);
        await r.deliver(helloReply, (f) => (f.type === 'replica' ? replayDelivered : true));

        // node-b RETRANSMITS the same opId: same hubSeq 1 from the idempotence cache, so whether
        // node-a is pushed depends entirely on whether the replay's watermark advance was recorded.
        await r('node-b', opsFrame([op], 'project', 'proj-1'));
        return pushedToA;
      }

      // Confirmed: node-a demonstrably holds hubSeq 1, so the retransmit is filtered out.
      expect(await runScenario(true)).toEqual([]);
      // Withheld: the hub never learned it landed, so it is still owed and the retransmit delivers it.
      expect((await runScenario(false)).map((f) => f.changes.map((c) => c.entityId))).toEqual([['t-x']]);
    });
  });

  // ---- presence -----------------------------------------------------------------------------

  describe('presence', () => {
    function presenceFrame(): ClusterPresenceFrame {
      return {
        type: 'presence',
        protocol: CLUSTER_PROTOCOL,
        capacity: { maxParallel: 4, active: 1, heavyActive: 0, enforcement: 'none' },
        repoDrift: [],
      };
    }

    it('a known node is stamped in peers.json and the reply is empty — no downlink frame for presence', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a' }), { env: env() });
      const replies = await router()('node-a', presenceFrame());
      expect(replies).toEqual([]);
      const peers = await readPeers({ env: env() });
      expect(peers.nodes[0]?.lastSeenAt).toBeTruthy();
      expect(peers.nodes[0]?.capacity?.active).toBe(1);
    });

    it('an unrostered node warns instead of fabricating a row, and still replies empty', async () => {
      const warn = vi.fn();
      const replies = await router({ warn })('ghost', presenceFrame());
      expect(replies).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('ghost');
      const peers = await readPeers({ env: env() });
      expect(peers.nodes).toEqual([]); // never fabricated
    });
  });

  // ---- freshness: observed and logged, never persisted ------------------------------------------

  describe('freshness', () => {
    it('is observed via warn and never written anywhere, with no refusal', async () => {
      const warn = vi.fn();
      const frame: ClusterFreshnessFrame = {
        type: 'freshness',
        protocol: CLUSTER_PROTOCOL,
        projectKey: 'pk-1',
        headSha: 'a'.repeat(40),
        ahead: 0,
        behind: 2,
        dirty: 0,
        merging: false,
      };
      const replies = await router({ warn })('node-a', frame);
      expect(replies).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('node-a');
      expect(message).toContain('pk-1');
      expect(message).toContain('no hub-side store yet');
      expect(message).not.toContain('refused dispatch');
    });

    it('a refused freshness report includes the dispatch id and reason in the warning', async () => {
      const warn = vi.fn();
      const frame: ClusterFreshnessFrame = {
        type: 'freshness',
        protocol: CLUSTER_PROTOCOL,
        projectKey: 'pk-1',
        headSha: 'a'.repeat(40),
        ahead: 0,
        behind: 0,
        dirty: 3,
        merging: false,
        refused: { dispatchId: 'dsp-1', reason: 'dirty' },
      };
      await router({ warn })('node-a', frame);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('refused dispatch dsp-1: dirty');
    });
  });

  // ---- ops: no ack, no apply ----------------------------------------------------------------

  describe('ops', () => {
    it('replies empty and warns naming the op count — never a fabricated ack', async () => {
      const warn = vi.fn();
      const frame: ClusterOpsFrame = {
        type: 'ops',
        protocol: CLUSTER_PROTOCOL,
        scope: 'project',
        projectKey: 'pk-1',
        ops: [],
      };
      const replies = await router({ warn })('node-a', frame);
      expect(replies).toEqual([]);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('0 op(s)');
      expect(message).toContain('no ack sent');
    });
  });

  // ---- ops: replication WIRED (Milestone B handoff, "the single most important thing to know") ---
  //
  // The `ops` describe block above tests the `!deps.replication` early return exclusively — every
  // one of its cases builds `deps` with no `replication` field, so none of them exercise the ~80
  // lines below that guard (allocation, apply, idempotence, fan-out, watermark bookkeeping). This
  // block is written to close exactly that gap: every test here passes a real `replication` object
  // and asserts on the thing it names (a `replica` frame was actually built and actually pushed),
  // never on the `ack` alone. See the spec's handoff block, "the cases that need to exist and do
  // not," items 1-5; item 6 ("no replication wired -> still warns and returns `[]`, never a
  // fabricated ack") already exists above and is not duplicated here.
  describe('ops — replication wired', () => {
    it('an accepted batch replies [ack, ...origins own replica frames], ack first', async () => {
      const sentTo = new Map<string, ClusterReplicaFrame[]>();
      const replication = makeReplication({
        connectedNodes: () => ['node-a'],
        sendTo: (nodeId, frame) => {
          const list = sentTo.get(nodeId) ?? [];
          list.push(frame as ClusterReplicaFrame);
          sentTo.set(nodeId, list);
          return true;
        },
      });
      const frame = opsFrame(
        [makeOp('op-1', { entityId: 'todo-1' }), makeOp('op-2', { entityId: 'todo-2' })],
        'project',
        'proj-1',
      );

      const replies = await router({ replication })('node-a', frame);

      expect(replies).toHaveLength(2);
      expect(replies[0]?.type).toBe('ack');
      const ack = replies[0] as ClusterAckFrame;
      expect(ack.results?.map((r) => r.opId)).toEqual(['op-1', 'op-2']);
      expect(ack.results?.every((r) => r.accepted)).toBe(true);

      expect(replies[1]?.type).toBe('replica');
      const replica = replies[1] as ClusterReplicaFrame;
      expect(replica.changes.map((c) => c.entityId)).toEqual(['todo-1', 'todo-2']);

      // The origin is a fan-out target too (D4/replica-fanout.ts), but it never goes through
      // `sendTo` — its own frames ride the router's return value instead, behind the ack.
      expect(sentTo.has('node-a')).toBe(false);
    });

    it('a second connected node is pushed via sendTo, and the returned frames do not include it', async () => {
      const sentToB: ClusterReplicaFrame[] = [];
      const replication = makeReplication({
        connectedNodes: () => ['node-a', 'node-b'],
        sendTo: (nodeId, frame) => {
          if (nodeId === 'node-b') sentToB.push(frame as ClusterReplicaFrame);
          return true;
        },
      });
      const frame = opsFrame([makeOp('op-1', { entityId: 'todo-1' })], 'project', 'proj-1');

      const replies = await router({ replication })('node-a', frame);

      // ack + exactly one replica frame (the origin's own) — never a second one smuggled into the
      // return value for node-b, which was pushed instead.
      expect(replies).toHaveLength(2);
      expect(replies.filter((f) => f.type === 'replica')).toHaveLength(1);

      expect(sentToB).toHaveLength(1);
      expect(sentToB[0]?.changes.map((c) => c.entityId)).toEqual(['todo-1']);
    });

    it('a rejected op never appears in a replica frame, but its rejection appears in ack.results with the winners fields', async () => {
      const replication = makeReplication({
        connectedNodes: () => ['node-a'],
        applyOp: async (op) => {
          if (op.entityId === 'todo-2') {
            return { accepted: false, reason: 'already-claimed', fields: { startedOn: 'node-c' } };
          }
          return { accepted: true };
        },
      });
      const frame = opsFrame(
        [makeOp('op-1', { entityId: 'todo-1' }), makeOp('op-2', { entityId: 'todo-2' })],
        'project',
        'proj-1',
      );

      const replies = await router({ replication })('node-a', frame);

      const ack = replies[0] as ClusterAckFrame;
      const rejected = ack.results?.find((r) => r.opId === 'op-2');
      expect(rejected).toMatchObject({
        accepted: false,
        reason: 'already-claimed',
        fields: { startedOn: 'node-c' },
      });

      const replica = replies.find((f) => f.type === 'replica') as ClusterReplicaFrame | undefined;
      expect(replica?.changes.map((c) => c.entityId)).toEqual(['todo-1']); // never todo-2
    });

    it(
      'sendTo returning false leaves the watermark unadvanced so a retransmit is still owed — ' +
        'positive control: a successful send advances it and the retransmit is NOT resent',
      async () => {
        async function runScenario(sendSucceeds: boolean): Promise<ClusterReplicaFrame[]> {
          const sentToB: ClusterReplicaFrame[] = [];
          const replication = makeReplication({
            connectedNodes: () => ['node-a', 'node-b'],
            sendTo: (nodeId, frame) => {
              if (nodeId === 'node-b') {
                sentToB.push(frame as ClusterReplicaFrame);
                return sendSucceeds;
              }
              return true;
            },
          });
          const r = router({ replication });
          const op = makeOp('op-x', { entityId: 'todo-x' });
          // Batch 1: first delivery attempt. Batch 2: a retransmit of the SAME op (same opId) — the
          // idempotence cache in `hub-ops.ts` answers it from cache rather than re-applying, so this
          // exercises the router's fan-out against whatever watermark batch 1 left behind, not a
          // fresh allocation.
          await r('node-a', opsFrame([op], 'project', 'proj-1'));
          await r('node-a', opsFrame([op], 'project', 'proj-1'));
          return sentToB;
        }

        const failed = await runScenario(false);
        expect(failed).toHaveLength(2); // still owed on the retransmit
        expect(failed[1]?.changes.map((c) => c.entityId)).toEqual(['todo-x']);

        const succeeded = await runScenario(true);
        expect(succeeded).toHaveLength(1); // delivered once; the retransmit is not resent
      },
    );

    it(
      'a hello carrying a LOWER appliedThroughHubSeq than the hub last sent overwrites it ' +
        '(seedWatermark is a SET, not a max) — a retransmit is then re-owed',
      async () => {
        const sentToA: ClusterReplicaFrame[] = [];
        const replication = makeReplication({
          connectedNodes: () => ['node-a', 'node-b'],
          sendTo: (nodeId, frame) => {
            if (nodeId === 'node-a') sentToA.push(frame as ClusterReplicaFrame);
            return true;
          },
        });
        const r = router({ replication });
        await upsertNode(makeStoredNode({ nodeId: 'node-a' }), { env: env() });

        // node-a is a spoke here, not the origin — node-b sends the op, node-a is pushed via sendTo.
        // `nodeId: 'node-b'` is not decoration: an op's author must be the node that sends it, or
        // the forged-author guard refuses it and nothing fans out at all. `makeOp` defaults to
        // 'node-a', which is right for every test that sends AS node-a and wrong here — the sibling
        // scope-isolation test below sets it explicitly for the same reason.
        const op = makeOp('op-w', { entityId: 'todo-w', nodeId: 'node-b' });
        await r('node-b', opsFrame([op], 'project', 'proj-1'));
        expect(sentToA).toHaveLength(1); // watermark(node-a) advances to hubSeq 1

        // node-a reconnects and reports it has only applied through 0 — LOWER than the 1 the hub
        // just sent it. This must SET the watermark back to 0, not be ignored as stale.
        const hello = helloFrame({
          nodeId: 'node-a',
          watermarks: [{ scope: 'project', projectKey: 'proj-1', appliedThroughHubSeq: 0, ackedThroughHubSeq: 0 }],
        });
        await r('node-a', hello);

        // The SAME op is retransmitted (same opId, cache hit, hubSeq reused from batch 1).
        await r('node-b', opsFrame([op], 'project', 'proj-1'));

        // If the low hello correctly SET the watermark back to 0, the op is owed again. If seeding
        // were wrongly monotonic (the bug the module docblock names and was corrected the same day
        // it was introduced), the watermark would still read 1 and this retransmit would be dropped.
        expect(sentToA).toHaveLength(2);
        expect(sentToA[1]?.changes.map((c) => c.entityId)).toEqual(['todo-w']);
      },
    );

    // D40b — the consequence of the identity guard returning BEFORE `watermarks.delete(nodeId)`,
    // observed directly on the watermark the hub holds rather than through a proxy for it. The two
    // halves differ in exactly one character (the claimed nodeId) and nothing else, so the second
    // half is a true control: it proves the retransmit machinery works and that the first half's
    // silence is the forged hello's doing, not a broken fixture.
    //
    // This is why `closeAfterWrite` is load-bearing and not tidiness. The hub's memory of node-a is
    // NOT corrected by a forged hello, so before the close existed the node stayed a fan-out target
    // carrying a stale, possibly too-high mark — D30 root cause 1, reopened. The fix is not to make
    // the forged path reseed (that would let an unauthenticated claim move the hub's state, which
    // is the whole thing the guard refuses); it is to stop serving the node at all.
    it('a FORGED hello reseeds NOTHING — the hub keeps its stale watermark, which is why the link must be ended (D40b)', async () => {
      const sentToA: ClusterReplicaFrame[] = [];
      const replication = makeReplication({
        connectedNodes: () => ['node-a', 'node-b'],
        sendTo: (nodeId, frame) => {
          if (nodeId === 'node-a') sentToA.push(frame as ClusterReplicaFrame);
          return true;
        },
      });
      const r = router({ replication });
      await upsertNode(makeStoredNode({ nodeId: 'node-a' }), { env: env() });
      await upsertNode(makeStoredNode({ nodeId: 'node-b' }), { env: env() });

      const op = makeOp('op-forged', { entityId: 'todo-forged', nodeId: 'node-b' });
      await r('node-b', opsFrame([op], 'project', 'proj-1'));
      expect(sentToA).toHaveLength(1); // watermark(node-a) advances to hubSeq 1

      const reported = [{ scope: 'project' as const, projectKey: 'proj-1', appliedThroughHubSeq: 0, ackedThroughHubSeq: 0 }];

      // node-a says it has applied nothing — but names node-b as itself. Refused, and the reseed
      // below the guard never runs.
      await r.raw('node-a', helloFrame({ nodeId: 'node-b', watermarks: reported }));
      await r('node-b', opsFrame([op], 'project', 'proj-1'));
      expect(sentToA).toHaveLength(1); // still 1: the hub still believes node-a holds hubSeq 1

      // CONTROL — the identical claim, honestly attributed. Now the watermark is SET back to 0 and
      // the same retransmit is owed again.
      await r.raw('node-a', helloFrame({ nodeId: 'node-a', watermarks: reported }));
      await r('node-b', opsFrame([op], 'project', 'proj-1'));
      expect(sentToA).toHaveLength(2);
      expect(sentToA[1]?.changes.map((c) => c.entityId)).toEqual(['todo-forged']);
    });

    it('watermarkKey keeps workspace and project:<key> scopes independent — one does not shadow the other', async () => {
      const sentToA: ClusterReplicaFrame[] = [];
      const replication = makeReplication({
        connectedNodes: () => ['node-a', 'node-b'],
        sendTo: (nodeId, frame) => {
          if (nodeId === 'node-a') sentToA.push(frame as ClusterReplicaFrame);
          return true;
        },
      });
      const r = router({ replication });

      // Independent (scope, projectKey) counters both start at hubSeq 1 — see hub-seq.ts's own
      // docblock ("workspace scope ignores any projectKey... one independent monotonic sequence per
      // pair"). A workspace-scoped op and a project-scoped op can therefore legitimately share the
      // same hubSeq number; only the (scope, projectKey) KEY tells them apart.
      const workspaceOp: ClusterOp = {
        opId: 'op-ws',
        nodeId: 'node-b',
        ts: new Date().toISOString(),
        scope: 'workspace',
        entity: 'todo',
        entityId: 'todo-ws',
        op: 'upsert',
        fields: { status: 'in_progress' },
      };
      await r('node-b', opsFrame([workspaceOp], 'workspace'));

      const projectOp = makeOp('op-pj', { entityId: 'todo-pj', nodeId: 'node-b' });
      await r('node-b', opsFrame([projectOp], 'project', 'proj-1'));

      // Both pushes must reach node-a independently. A merged watermark key would make the second
      // (project) push look already-delivered — because the first (workspace) push already advanced
      // the shared key to hubSeq 1 — and silently swallow it.
      expect(sentToA).toHaveLength(2);
      expect(sentToA[0]?.scope).toBe('workspace');
      expect(sentToA[1]?.scope).toBe('project');
      expect(sentToA[1]?.changes.map((c) => c.entityId)).toEqual(['todo-pj']);
    });

    // D29 follow-up: an op whose content alone (with its replica-frame envelope) is over
    // CLUSTER_FRAME_MAX_BYTES used to make `planReplicaFanout` throw, which aborted this whole
    // handler — no ack, no replication for anything else in the same batch. It is now EXCLUDED and
    // reported instead (see `replica-fanout.ts`'s own docblock, "Frame cap" → "The single-oversized-
    // op case"); this is the integration-level proof that the rest of the batch, and the origin's
    // own ack, survive it.
    it('an oversized op is excluded, not thrown: normal ops in the same batch still replicate, the origin still gets its ack, and the exclusion is warned', async () => {
      const warnings: string[] = [];
      const replication = makeReplication({ connectedNodes: () => ['node-a'] });
      const huge = makeOp('op-huge', {
        entityId: 'huge',
        fields: { body: 'x'.repeat(CLUSTER_FRAME_MAX_BYTES + 1_000) },
      });
      const normal = makeOp('op-normal', { entityId: 'normal' });
      const frame = opsFrame([huge, normal], 'project', 'proj-1');

      const replies = await router({ replication, warn: (m) => warnings.push(m) })('node-a', frame);

      // The ack is the whole point — it is what stops the origin's outbox resending. Both ops were
      // durably APPLIED at the hub (D4): exclusion is a replication-layer concern, never an
      // apply-time refusal, so both are accepted.
      expect(replies[0]?.type).toBe('ack');
      const ack = replies[0] as ClusterAckFrame;
      expect(ack.results?.map((r) => r.opId)).toEqual(['op-huge', 'op-normal']);
      expect(ack.results?.every((r) => r.accepted)).toBe(true);

      // The normal op still replicates even though the huge one in the SAME batch could not.
      const replica = replies.find((f) => f.type === 'replica') as ClusterReplicaFrame | undefined;
      expect(replica?.changes.map((c) => c.entityId)).toEqual(['normal']); // never 'huge'

      // The exclusion is warned, by name, naming the target and (since node-a is both sender and
      // sole connected node here) flagging that this IS the origin — the worse-consequence case.
      const exclusionWarning = warnings.find((w) => w.includes('REPLICATION-EXCLUDED'));
      expect(exclusionWarning).toBeDefined();
      expect(exclusionWarning).toContain('op-huge');
      expect(exclusionWarning).toContain('node-a');
      expect(exclusionWarning).toContain('origin');
    });

    // D28 (F4): the origin branch used to call `advanceWatermark` unconditionally right after
    // pushing its own replica frame onto the return channel — a channel `link-server.ts` writes to
    // strictly AFTER this router has already returned, with no delivery signal fed back. So a
    // dropped write there (oversized, send-budget exhaustion — see `link-server.ts`'s own D28 fix)
    // was recorded as delivered.
    //
    // SUPERSEDED the same day: an intermediate fix answered this by never advancing the origin's
    // watermark at all, and a test here pinned that. Safe, but it answers the wrong question — see
    // the origin branch's own comment in `hub-router.ts`. The fix is now a real delivery report
    // (`ClusterFrameReplies#onWritten`), so the two halves below are a matched pair and NEITHER is
    // meaningful alone: withheld delivery must leave the frame owed, and confirmed delivery must
    // retire it. A test with only the first half passes just as well against "never advance", which
    // is exactly the behaviour being replaced.
    it(
      "the origin's own watermark advances ONLY on a CONFIRMED write: an undelivered replica is still " +
        'owed on a retransmit — positive control: a delivered one is not re-sent (D28/F4)',
      async () => {
        /** @returns the replica frames the origin was OFFERED on each of two identical batches. */
        async function runScenario(originWriteSucceeds: boolean): Promise<(ClusterReplicaFrame | undefined)[]> {
          const replication = makeReplication({ connectedNodes: () => ['node-a'] });
          const r = router({ replication });
          const op = makeOp('op-self', { entityId: 'todo-self', nodeId: 'node-a' });
          // The ack always lands; only the origin's own replica frame is withheld, which is the
          // real shape of a send-budget or oversize drop mid-batch.
          const canDeliver = (frame: ClusterDownlinkFrame): boolean =>
            frame.type === 'replica' ? originWriteSucceeds : true;

          const offered: (ClusterReplicaFrame | undefined)[] = [];
          for (let i = 0; i < 2; i += 1) {
            // Batch 2 is a RETRANSMIT of the same opId: `op-history`'s idempotence cache answers it
            // with the same verdict and the same hubSeq, so `applied` carries it again and the only
            // thing deciding whether a frame is built is the origin's watermark.
            const reply = await r.raw('node-a', opsFrame([op], 'project', 'proj-1'));
            offered.push(reply.frames.find((f): f is ClusterReplicaFrame => f.type === 'replica'));
            await r.deliver(reply, canDeliver);
          }
          return offered;
        }

        // Withheld: the hub never learned the frame landed, so it must still consider it owed.
        const withheld = await runScenario(false);
        expect(withheld[0]?.changes.map((c) => c.entityId)).toEqual(['todo-self']);
        expect(withheld[1]?.changes.map((c) => c.entityId)).toEqual(['todo-self']);

        // Delivered: the watermark moved, so `owedFor` filters the retransmit out entirely — no
        // duplicate replica for a frame the origin demonstrably already has.
        const delivered = await runScenario(true);
        expect(delivered[0]?.changes.map((c) => c.entityId)).toEqual(['todo-self']);
        expect(delivered[1]).toBeUndefined();
      },
    );
  });

  // ---- ops: the forged-author guard ------------------------------------------------------------
  //
  // The `hello` identity guard's principle, one layer down: the socket's authenticated identity
  // wins over the frame body. It matters because `server/cluster-routes.ts` authorizes an op's
  // PROJECT from `op.nodeId` — D20/D21's both-ways-confirmed pairing gate, the same one the HTTP
  // `/cluster/todos/*` family enforces. Without this guard a node borrows another node's pairings
  // simply by writing its name into an op, and that gate is enforced on the socket path in name
  // only. Every test here removes the guard's effect if the guard is removed; none of them passes
  // by accident of the fixture, because `makeOp` defaults the author to 'node-a' and each case
  // states the author it means.
  describe('ops — the forged-author guard', () => {
    it('an op whose nodeId disagrees with the authenticated node is refused, never applied, and never replicated', async () => {
      const applied: ClusterOp[] = [];
      const sentToB: ClusterReplicaFrame[] = [];
      const replication = makeReplication({
        connectedNodes: () => ['node-a', 'node-b'],
        sendTo: (nodeId, frame) => {
          if (nodeId === 'node-b') sentToB.push(frame as ClusterReplicaFrame);
          return true;
        },
        applyOp: async (op) => {
          applied.push(op);
          return { accepted: true };
        },
      });

      // Authenticated as node-a; the op writes node-b's name into its own author field.
      const frame = opsFrame([makeOp('op-f', { entityId: 'todo-f', nodeId: 'node-b' })], 'project', 'proj-1');
      const replies = await router({ replication })('node-a', frame);

      const ack = replies[0] as ClusterAckFrame;
      expect(ack.type).toBe('ack');
      expect(ack.results).toHaveLength(1);
      expect(ack.results?.[0]).toMatchObject({ opId: 'op-f', accepted: false });
      // The reason names BOTH sides — the name claimed, and the credential that sent it.
      expect(ack.results?.[0]?.reason).toContain('forged-author');
      expect(ack.results?.[0]?.reason).toContain('"node-b"');
      expect(ack.results?.[0]?.reason).toContain('"node-a"');

      // NEVER applied: the store is not reached at all for a forged op. Asserting on the ack alone
      // would still pass if the guard ran AFTER the write.
      expect(applied).toEqual([]);
      // ...and never replicated — not to the origin through the return value, not to anyone else
      // through `sendTo`.
      expect(replies.filter((f) => f.type === 'replica')).toEqual([]);
      expect(sentToB).toEqual([]);
    });

    it('refuses ONLY the forged op — an honest op in the same frame is still applied and replicated', async () => {
      const applied: ClusterOp[] = [];
      const replication = makeReplication({
        connectedNodes: () => ['node-a'],
        applyOp: async (op) => {
          applied.push(op);
          return { accepted: true };
        },
      });

      // Refusing the whole FRAME instead (the `hello` posture) would take `op-ok` down with it. Which
      // ops share a frame is a packing detail — `ops.ts#packOpsFrame` slices by op count and byte
      // budget — so a whole-frame refusal would make an honest op's fate depend on its neighbours.
      const frame = opsFrame(
        [
          makeOp('op-ok', { entityId: 'todo-ok', nodeId: 'node-a' }),
          makeOp('op-forged', { entityId: 'todo-forged', nodeId: 'node-b' }),
        ],
        'project',
        'proj-1',
      );
      const replies = await router({ replication })('node-a', frame);

      const ack = replies[0] as ClusterAckFrame;
      expect(ack.results?.map((r) => [r.opId, r.accepted])).toEqual([
        ['op-ok', true],
        ['op-forged', false],
      ]);
      expect(applied.map((op) => op.opId)).toEqual(['op-ok']);

      const replica = replies.find((f) => f.type === 'replica') as ClusterReplicaFrame | undefined;
      expect(replica?.changes.map((c) => c.entityId)).toEqual(['todo-ok']);
    });

    it('the refusal is DURABLE, not a gap: throughHubSeq advances past it so the spoke stops owing it', async () => {
      const replication = makeReplication({ connectedNodes: () => ['node-a'] });
      const frame = opsFrame([makeOp('op-f', { entityId: 'todo-f', nodeId: 'node-b' })], 'project', 'proj-1');
      const ack = (await router({ replication })('node-a', frame))[0] as ClusterAckFrame;

      // This is the whole difference between refusing at the `applyOp` seam and filtering the op out
      // of the frame up front. Filtering would leave `results` empty and `throughHubSeq` at 0 — what
      // `hub-ops.ts` calls a GAP — and the spoke would resend this op every flush tick forever, for a
      // verdict that can never change. A RETURNED rejection is a resolved verdict: it is allocated a
      // hubSeq, it appears in `results` with its reason, and the watermark covers it.
      expect(ack.throughHubSeq).toBe(1);
      expect(ack.results).toHaveLength(1);
      expect(ack.results?.[0]?.hubSeq).toBe(1);
      expect(ack.results?.[0]?.accepted).toBe(false);
    });

    it('warns ONCE per frame, naming both sides and every distinct claimed id — never once per op', async () => {
      const warn = vi.fn();
      const replication = makeReplication({ connectedNodes: () => ['node-a'] });
      const frame = opsFrame(
        [
          makeOp('op-1', { entityId: 't1', nodeId: 'node-b' }),
          makeOp('op-2', { entityId: 't2', nodeId: 'node-b' }),
          makeOp('op-3', { entityId: 't3', nodeId: 'node-c' }),
          makeOp('op-4', { entityId: 't4', nodeId: 'node-a' }), // honest — the sender's own name
        ],
        'project',
        'proj-1',
      );
      await router({ warn, replication })('node-a', frame);

      // ONE line, not three. A frame may legally carry `CLUSTER_OPS_PER_FRAME_MAX` (500) ops, so a
      // per-op warning would let a single misbehaving node flood the log 500 entries at a time.
      expect(warn).toHaveBeenCalledTimes(1);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('REFUSED-FORGED-AUTHOR');
      expect(message).toContain('3 of 4 op(s)');
      expect(message).toContain('"node-b"'); // claimed, and deduped — it appears on two ops
      expect(message).toContain('"node-c"'); // every DISTINCT claimed id, not just the first
      expect(message).toContain('"node-a"'); // the credential that actually sent the frame
      expect(message).toContain('proj-1');
    });
  });

  // ---- relay: not implemented ----------------------------------------------------------------

  describe('relay', () => {
    it('replies empty and warns naming the run id', async () => {
      const warn = vi.fn();
      const frame: ClusterRelayFrame = {
        type: 'relay',
        protocol: CLUSTER_PROTOCOL,
        runId: 'run-1',
        events: [],
      };
      const replies = await router({ warn })('node-a', frame);
      expect(replies).toEqual([]);
      const message = warn.mock.calls[0]?.[0] as string;
      expect(message).toContain('run-1');
      expect(message).toContain('not implemented yet');
    });
  });
});
