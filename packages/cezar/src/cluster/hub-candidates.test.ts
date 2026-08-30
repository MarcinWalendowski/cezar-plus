import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  clusterCapacitySchema,
  type ClusterCapacity,
  type ClusterNodeId,
  type ClusterProjectKey,
  type StoredClusterNode,
  type StoredClusterNodeIdentity,
  type StoredClusterPeers,
} from '@loki-labs/cezar-plus-contract';
import { WorkspaceSemaphore, type SemaphoreParticipant } from '../workspace/semaphore.ts';
import { buildPlacementCandidates, stampAgeMs, type HoldsProjectResolver } from './hub-candidates.ts';
import { peersPath } from './peers.ts';
import type { PlacementCandidate } from './placement.ts';

/**
 * Phase 3 of the Milestone C hub half (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * D11 · D12 · D14 · D14a; B11's census is why this module had to be written rather than wired).
 *
 * **Every fixture below carries at least two nodes that DIFFER along the axis under test.** That is
 * not style. Six defects on this branch were unfalsifiable purely because every fixture had one
 * project / one node / one candidate — the spec states the rule outright: *"without a deliberate
 * non-matching second row, 'candidates are the pairings mentioning this node' and 'candidates are
 * every pairing' are indistinguishable, and the filter could be deleted with the file still
 * green."* A single-candidate fixture cannot distinguish any selection rule from any other, and one
 * such fixture survived a real-socket e2e on this same branch.
 *
 * The three derivations most likely to be got wrong silently each have a named mutation recorded
 * beside them — the mutation was applied, the suite went RED, and the original was restored.
 */
describe('cluster/hub-candidates', () => {
  const NOW = new Date('2026-08-23T12:00:00.000Z');
  const PROJECT: ClusterProjectKey = 'proj-key-1';
  const HUB_ID: ClusterNodeId = 'hub-node';

  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-hub-candidates-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /** `env` is threaded explicitly rather than pinned on `process.env`: every path this module
   *  reads (`peersPath` → `clusterHomeDir` → `cezarHomeDir`, and the isolation probe behind
   *  `detectCapacityEnforcement`) takes the bag, so the suite never mutates a worker-wide global
   *  and cannot leak a pin into a sibling file. */
  function options(): { env: NodeJS.ProcessEnv } {
    return { env: { CEZ_HOME: home } };
  }

  function writePeers(peers: Partial<StoredClusterPeers>): void {
    const path = peersPath(options().env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ nodes: [], pairings: [], ...peers }), 'utf8');
  }

  function storedNode(overrides: Partial<StoredClusterNode> = {}): StoredClusterNode {
    return {
      nodeId: 'node-a',
      nodeName: 'Node A',
      role: 'spoke',
      labels: ['macos'],
      acceptsDispatch: true,
      protocol: CLUSTER_PROTOCOL,
      version: '0.10.0',
      lastSeenAt: '2026-08-23T11:59:55.000Z',
      capacity: { maxParallel: 4, active: 1, heavyActive: 0, enforcement: 'process-tree' },
      capacityAt: '2026-08-23T11:59:55.000Z',
      ...overrides,
    };
  }

  function identity(overrides: Partial<StoredClusterNodeIdentity> = {}): StoredClusterNodeIdentity {
    return {
      nodeId: HUB_ID,
      nodeName: 'Hub',
      createdAt: '2026-08-01T00:00:00.000Z',
      role: 'hub',
      acceptsDispatch: true,
      labels: ['cgroup'],
      ...overrides,
    };
  }

  /** A `SemaphoreParticipant` stub holding `slots` — `busy()` sums registered participants, so
   *  this is the only way to make the LIVE semaphore report a non-zero load without starting runs. */
  function participant(slots: number): SemaphoreParticipant {
    return { busySlots: () => slots, pump: () => {}, oldestQueuedAt: () => null };
  }

  function semaphore(input: { maxParallel?: number; maxHeavySteps?: number; busy?: number } = {}): WorkspaceSemaphore {
    const sem = new WorkspaceSemaphore({
      initial: {
        maxParallel: input.maxParallel ?? 4,
        ...(input.maxHeavySteps !== undefined ? { maxHeavySteps: input.maxHeavySteps } : {}),
      },
    });
    if (input.busy !== undefined) sem.register(participant(input.busy));
    return sem;
  }

  /** Stands in for the injected D20/D21 gate the wiring caller fills with
   *  `resolveHubTodosRoot(projectKey, nodeId, env) !== undefined`. Records every call so a test can
   *  assert the module consults it PER CANDIDATE rather than once, or not at all. */
  function holdsProjectFake(confirmed: readonly ClusterNodeId[]): HoldsProjectResolver & {
    calls: Array<[ClusterProjectKey, ClusterNodeId]>;
  } {
    const allowed = new Set(confirmed);
    const calls: Array<[ClusterProjectKey, ClusterNodeId]> = [];
    const fn = (projectKey: ClusterProjectKey, nodeId: ClusterNodeId): Promise<boolean> => {
      calls.push([projectKey, nodeId]);
      return Promise.resolve(allowed.has(nodeId));
    };
    return Object.assign(fn, { calls });
  }

  function build(input: {
    connectedNodeIds?: readonly ClusterNodeId[];
    now?: Date;
    hubIdentity?: StoredClusterNodeIdentity;
    semaphore?: WorkspaceSemaphore;
    holdsProject?: HoldsProjectResolver;
  } = {}): Promise<PlacementCandidate[]> {
    return buildPlacementCandidates(
      {
        projectKey: PROJECT,
        hubIdentity: input.hubIdentity ?? identity(),
        connectedNodeIds: input.connectedNodeIds ?? [],
        now: input.now ?? NOW,
        semaphore: input.semaphore ?? semaphore(),
        holdsProject: input.holdsProject ?? holdsProjectFake([]),
      },
      options(),
    );
  }

  function byId(candidates: readonly PlacementCandidate[], nodeId: ClusterNodeId): PlacementCandidate {
    const found = candidates.filter((c) => c.nodeId === nodeId);
    expect(found).toHaveLength(1);
    return found[0]!;
  }

  // ---- online: from the LINK, never from `lastSeenAt` -------------------------------------------

  describe('online', () => {
    /**
     * The hazard this module exists for. Both nodes below carry the SAME, five-seconds-old
     * `lastSeenAt` — so a derivation that reads the roster's freshness instead of the link answers
     * `true` for both and cannot be told apart from the correct one by any single-node fixture.
     *
     * **REQUIRED mutation (applied, RED, restored):** replace
     * `online: connected.has(node.nodeId)` with
     * `online: node.lastSeenAt !== undefined && input.now.getTime() - Date.parse(node.lastSeenAt) < 60_000`.
     * `node-asleep` then reports `online: true`.
     */
    it('is true only for a node the link server reports connected, whatever `lastSeenAt` says', async () => {
      // **The node that must NOT be online is FIRST.** Ordering is load-bearing: with the
      // connected node first, a `derive it for row 0 and default the rest to false` bug produces
      // exactly the expected values and this test agrees with it. Measured — that mutation was
      // green here until this order was flipped.
      writePeers({
        nodes: [
          storedNode({ nodeId: 'node-asleep', lastSeenAt: '2026-08-23T11:59:55.000Z' }),
          storedNode({ nodeId: 'node-linked', lastSeenAt: '2026-08-23T11:59:55.000Z' }),
        ],
      });

      const candidates = await build({ connectedNodeIds: ['node-linked'] });

      expect(byId(candidates, 'node-linked').online).toBe(true);
      expect(byId(candidates, 'node-asleep').online).toBe(false);
      // The negative half of the same fact: the two rows are identical on the field a wrong
      // derivation would read, so the assertion above can only be produced by the link.
      expect(byId(candidates, 'node-linked').capacityAgeMs).toBe(byId(candidates, 'node-asleep').capacityAgeMs);
    });

    it('is false for a node with NO `lastSeenAt` that the link reports connected — the inverse case', async () => {
      // A node that just completed its handshake and has never beaten would be `online: false`
      // under a `lastSeenAt` derivation and is `online: true` here. Second node differs on the axis.
      const linked = storedNode({ nodeId: 'node-fresh-socket' });
      delete linked.lastSeenAt;
      writePeers({ nodes: [linked, storedNode({ nodeId: 'node-other' })] });

      const candidates = await build({ connectedNodeIds: ['node-fresh-socket'] });

      expect(byId(candidates, 'node-fresh-socket').online).toBe(true);
      expect(byId(candidates, 'node-other').online).toBe(false);
    });
  });

  // ---- capacityAgeMs: unknown means stale, never fresh ------------------------------------------

  describe('capacityAgeMs', () => {
    /**
     * `capacityAt` is `z.string().optional()` and NOT `.datetime()`, so `"yesterday"` is a legal
     * roster value that `Date.parse` answers `NaN` for — and `NaN > bound` is `false`, i.e. FRESH.
     * The value must be `undefined` (unknown ⇒ stale), and specifically must not be `NaN`.
     *
     * **REQUIRED mutation (applied, RED, restored):** delete `if (!Number.isFinite(at)) return
     * undefined;` from `stampAgeMs`. `node-garbled` then reports `capacityAgeMs: NaN`.
     */
    it('is `undefined` — not NaN — for an unparsable stamp, and a real age for a parsable one', async () => {
      writePeers({
        nodes: [
          storedNode({ nodeId: 'node-timed', capacityAt: '2026-08-23T11:59:00.000Z' }),
          storedNode({ nodeId: 'node-garbled', capacityAt: 'yesterday' }),
        ],
      });

      const candidates = await build();

      expect(byId(candidates, 'node-timed').capacityAgeMs).toBe(60_000);
      const garbled = byId(candidates, 'node-garbled');
      expect(garbled.capacityAgeMs).toBeUndefined();
      expect(Number.isNaN(garbled.capacityAgeMs as number)).toBe(false);
      expect('capacityAgeMs' in garbled).toBe(false);
    });

    it('is `undefined` when the roster row carries no stamp at all', async () => {
      const unstamped = storedNode({ nodeId: 'node-unstamped' });
      delete unstamped.capacityAt;
      writePeers({ nodes: [unstamped, storedNode({ nodeId: 'node-stamped', capacityAt: '2026-08-23T11:59:00.000Z' })] });

      const candidates = await build();

      expect(byId(candidates, 'node-unstamped').capacityAgeMs).toBeUndefined();
      expect(byId(candidates, 'node-stamped').capacityAgeMs).toBe(60_000);
    });

    /**
     * A stamp AHEAD of `now` is not clock skew — `capacityAt` is written by this hub's own clock
     * inside `markNodeSeen`, never by the node it describes. A negative age reads as *fresher than
     * now* to every `age > bound` test downstream, which is the same fail-open the NaN guard closes.
     *
     * **Mutation (applied, RED, restored):** delete `if (age < 0) return undefined;`.
     * `node-ahead` then reports `capacityAgeMs: -60000`.
     */
    it('is `undefined` for a stamp in the future, while a past stamp on the sibling row is a number', async () => {
      writePeers({
        nodes: [
          storedNode({ nodeId: 'node-ahead', capacityAt: '2026-08-23T12:01:00.000Z' }),
          storedNode({ nodeId: 'node-behind', capacityAt: '2026-08-23T11:59:00.000Z' }),
        ],
      });

      const candidates = await build();

      expect(byId(candidates, 'node-ahead').capacityAgeMs).toBeUndefined();
      expect(byId(candidates, 'node-behind').capacityAgeMs).toBe(60_000);
    });

    it('stampAgeMs answers the three unprovable cases identically and a good stamp exactly', () => {
      expect(stampAgeMs(undefined, NOW)).toBeUndefined();
      expect(stampAgeMs('yesterday', NOW)).toBeUndefined();
      expect(stampAgeMs('2026-08-23T12:00:00.001Z', NOW)).toBeUndefined();
      expect(stampAgeMs('2026-08-23T11:30:00.000Z', NOW)).toBe(1_800_000);
      // Boundary: exactly `now` is age 0, not "in the future".
      expect(stampAgeMs('2026-08-23T12:00:00.000Z', NOW)).toBe(0);
    });
  });

  // ---- holdsProject: the injected D20/D21 gate, consulted per candidate --------------------------

  describe('holdsProject', () => {
    /**
     * **REQUIRED mutation (applied, RED, restored):** replace
     * `holdsProject: await input.holdsProject(input.projectKey, node.nodeId)` with
     * `holdsProject: true`. `node-unpaired` then reports `true`.
     */
    it('is the injected gate’s answer per node — false for a CONNECTED node the gate refuses', async () => {
      writePeers({
        nodes: [storedNode({ nodeId: 'node-paired' }), storedNode({ nodeId: 'node-unpaired' })],
      });
      const holds = holdsProjectFake(['node-paired']);

      // Both are connected, so `online` cannot be what produces the difference.
      const candidates = await build({ connectedNodeIds: ['node-paired', 'node-unpaired'], holdsProject: holds });

      expect(byId(candidates, 'node-paired').holdsProject).toBe(true);
      expect(byId(candidates, 'node-unpaired').holdsProject).toBe(false);
      expect(byId(candidates, 'node-paired').online).toBe(true);
      expect(byId(candidates, 'node-unpaired').online).toBe(true);
    });

    it('asks the gate about the hub itself and about every roster candidate, always with this projectKey', async () => {
      writePeers({ nodes: [storedNode({ nodeId: 'node-a' }), storedNode({ nodeId: 'node-b' })] });
      const holds = holdsProjectFake([HUB_ID]);

      const candidates = await build({ holdsProject: holds });

      expect(holds.calls).toEqual([
        [PROJECT, HUB_ID],
        [PROJECT, 'node-a'],
        [PROJECT, 'node-b'],
      ]);
      // And the hub's own answer is the gate's, not a hardcoded `true` for "the local machine".
      expect(byId(candidates, HUB_ID).holdsProject).toBe(true);
      expect(byId(candidates, 'node-a').holdsProject).toBe(false);
    });

    it('reports the hub as NOT holding a project its own gate refuses', async () => {
      writePeers({ nodes: [storedNode({ nodeId: 'node-a' })] });

      const candidates = await build({ holdsProject: holdsProjectFake(['node-a']) });

      expect(byId(candidates, HUB_ID).holdsProject).toBe(false);
      expect(byId(candidates, 'node-a').holdsProject).toBe(true);
    });
  });

  // ---- the hub's own candidate -------------------------------------------------------------------

  describe('the hub candidate', () => {
    it('is present and `online: true` with an EMPTY connected set — a hub holds no socket to itself', async () => {
      writePeers({ nodes: [storedNode({ nodeId: 'node-a' })] });

      const candidates = await build({ connectedNodeIds: [] });

      expect(byId(candidates, HUB_ID).online).toBe(true);
      // The discriminating half: the same empty set leaves the roster node offline, so `true` above
      // cannot have come from `connectedNodeIds`.
      expect(byId(candidates, 'node-a').online).toBe(false);
    });

    it('measures capacity off the live semaphore, with `capacityAgeMs: 0` and no corpus mirror', async () => {
      writePeers({ nodes: [storedNode({ nodeId: 'node-a' })] });
      const sem = semaphore({ maxParallel: 6, maxHeavySteps: 2, busy: 3 });
      let releaseHeavy = (): void => {};
      const heavyHeld = new Promise<void>((resolve) => {
        releaseHeavy = resolve;
      });
      const heavyStep = sem.runHeavyStep(() => heavyHeld);

      const hub = byId(await build({ semaphore: sem }), HUB_ID);

      expect(hub.capacity).toEqual({
        maxParallel: 6,
        active: 3,
        maxHeavySteps: 2,
        heavyActive: 1,
        enforcement: hub.capacity.enforcement,
      });
      // `enforcement` is probed from the host (cgroups / darwin / neither) and so cannot be pinned
      // to a literal on both a Mac and the Linux box. Asserted through the contract instead, which
      // is the stronger check anyway: it rejects any value outside the D14a enum.
      expect(clusterCapacitySchema.parse(hub.capacity)).toEqual(hub.capacity);
      expect(hub.capacityAgeMs).toBe(0);
      expect(hub.corpusStalenessMs).toBeUndefined();
      expect(hub.labels).toEqual(['cgroup']);

      releaseHeavy();
      await heavyStep;
    });

    /**
     * `WorkspaceSemaphore#maxHeavySteps()` answers `Infinity` for "no gate"; `ClusterCapacity`
     * spells that state as the field being ABSENT (`z.number().int()` — `Infinity` is not a legal
     * value), and `placement.ts#headroom` reads absent back as `POSITIVE_INFINITY`. The two rows
     * below differ on exactly that axis.
     */
    it('maps the semaphore’s unbounded heavy cap to an ABSENT `maxHeavySteps`, and a real one through', async () => {
      writePeers({ nodes: [] });

      const unbounded = byId(await build({ semaphore: semaphore({ maxParallel: 2 }) }), HUB_ID);
      const bounded = byId(await build({ semaphore: semaphore({ maxParallel: 2, maxHeavySteps: 5 }) }), HUB_ID);

      expect('maxHeavySteps' in unbounded.capacity).toBe(false);
      expect(unbounded.capacity.maxHeavySteps).toBeUndefined();
      expect(Number.isFinite(unbounded.capacity.maxHeavySteps as number)).toBe(false);
      // Would throw on `Infinity`: this is what makes the mapping a hard assertion rather than a
      // convention.
      expect(() => clusterCapacitySchema.parse(unbounded.capacity)).not.toThrow();
      expect(bounded.capacity.maxHeavySteps).toBe(5);
    });

    it('carries D11’s `acceptsDispatch` from the identity verbatim, in both directions', async () => {
      writePeers({ nodes: [] });

      const opted = byId(await build({ hubIdentity: identity({ acceptsDispatch: true }) }), HUB_ID);
      const notOpted = byId(await build({ hubIdentity: identity({ acceptsDispatch: false }) }), HUB_ID);

      expect(opted.acceptsDispatch).toBe(true);
      // The default is OFF, and it is never overridden to `true` for "the local machine" — a hub
      // that has not opted in is filtered out by `eligibleCandidates` like any other node.
      expect(notOpted.acceptsDispatch).toBe(false);
    });

    it('is built from live state even when a hand-edited roster carries a row for the hub’s own id', async () => {
      writePeers({
        nodes: [
          storedNode({
            nodeId: HUB_ID,
            labels: ['stale-label'],
            acceptsDispatch: false,
            capacity: { maxParallel: 99, active: 98, heavyActive: 7, enforcement: 'none' },
            capacityAt: '2026-08-23T11:00:00.000Z',
          }),
          storedNode({ nodeId: 'node-a' }),
        ],
      });

      const candidates = await build({ semaphore: semaphore({ maxParallel: 6, busy: 1 }) });

      // Exactly one — `byId` asserts that — and it is the measurement, not the row.
      const hub = byId(candidates, HUB_ID);
      expect(hub.capacity.maxParallel).toBe(6);
      expect(hub.capacity.active).toBe(1);
      expect(hub.capacityAgeMs).toBe(0);
      expect(hub.labels).toEqual(['cgroup']);
      // Negative control: the sibling row IS read, so the exclusion above is about the hub's id and
      // not about the roster being ignored wholesale.
      expect(byId(candidates, 'node-a').capacity.maxParallel).toBe(4);
    });
  });

  // ---- which roster rows are candidates at all ----------------------------------------------------

  describe('roster rows that are not candidates', () => {
    it('drops a revoked node and keeps its non-revoked sibling', async () => {
      writePeers({
        nodes: [
          storedNode({ nodeId: 'node-revoked', disabledAt: '2026-08-23T10:00:00.000Z' }),
          storedNode({ nodeId: 'node-live' }),
        ],
      });

      // Both are still on a socket: `disableNode` deletes the credential but does not close an
      // open link, so "connected" is exactly the state in which dropping it matters.
      const candidates = await build({ connectedNodeIds: ['node-revoked', 'node-live'] });

      expect(candidates.map((c) => c.nodeId)).toEqual([HUB_ID, 'node-live']);
    });

    it('drops a node that has never claimed a capacity and keeps the one that has', async () => {
      const never = storedNode({ nodeId: 'node-never-beat' });
      delete never.capacity;
      delete never.capacityAt;
      writePeers({ nodes: [never, storedNode({ nodeId: 'node-beat' })] });

      const candidates = await build({ connectedNodeIds: ['node-never-beat', 'node-beat'] });

      expect(candidates.map((c) => c.nodeId)).toEqual([HUB_ID, 'node-beat']);
    });

    it('keeps the FIRST of two rows sharing a nodeId, and both rows differ so the choice is visible', async () => {
      writePeers({
        nodes: [
          storedNode({
            nodeId: 'node-dup',
            capacity: { maxParallel: 4, active: 0, heavyActive: 0, enforcement: 'process-tree' },
          }),
          storedNode({
            nodeId: 'node-dup',
            capacity: { maxParallel: 40, active: 0, heavyActive: 0, enforcement: 'none' },
          }),
          storedNode({ nodeId: 'node-other' }),
        ],
      });

      const candidates = await build();

      expect(candidates.map((c) => c.nodeId)).toEqual([HUB_ID, 'node-dup', 'node-other']);
      expect(byId(candidates, 'node-dup').capacity.maxParallel).toBe(4);
    });

    it('returns the hub alone when the roster is empty or missing', async () => {
      // No `peers.json` written at all — the zero-config "no roster yet" state `readPeers` degrades
      // to. A hub that placed nothing here could never run its own work.
      const candidates = await build();

      expect(candidates.map((c) => c.nodeId)).toEqual([HUB_ID]);
    });
  });

  // ---- corpusStalenessMs -------------------------------------------------------------------------

  describe('corpusStalenessMs', () => {
    function corpus(fetchedAt: string): StoredClusterNode['corpus'] {
      return { version: 'v1', fetchedAt, scope: ['knowledge'], quarantined: 0 };
    }

    /**
     * `undefined` on this field means "holds no mirror", which `dispatch.ts#isCorpusStale`
     * explicitly treats as NOT stale — so an unreadable `fetchedAt` cannot degrade to `undefined`
     * without flipping its meaning from *unprovable* to *fine*. It degrades to `Infinity`, matching
     * `isCorpusStale` answering `true` for the same input.
     *
     * Three rows, differing on the axis, because two would leave the third state untested.
     */
    it('separates a real age, an unreadable stamp (Infinity), and no mirror at all (undefined)', async () => {
      writePeers({
        nodes: [
          storedNode({ nodeId: 'node-mirrors', corpus: corpus('2026-08-23T11:00:00.000Z') }),
          storedNode({ nodeId: 'node-garbled', corpus: corpus('sometime') }),
          storedNode({ nodeId: 'node-no-mirror' }),
        ],
      });

      const candidates = await build();

      expect(byId(candidates, 'node-mirrors').corpusStalenessMs).toBe(3_600_000);
      expect(byId(candidates, 'node-garbled').corpusStalenessMs).toBe(Number.POSITIVE_INFINITY);
      expect(byId(candidates, 'node-no-mirror').corpusStalenessMs).toBeUndefined();
      expect('corpusStalenessMs' in byId(candidates, 'node-no-mirror')).toBe(false);
    });
  });

  // ---- the whole row, once ------------------------------------------------------------------------

  /**
   * The `everyField` test the spec names as the cheapest fix for sparse fixtures (`replay.test.ts`
   * scored 21/21 RED on a per-field deletion sweep because of ONE case like this): a single
   * `toEqual` over a row carrying every declared field, so a derivation nobody thought to assert
   * individually is still pinned. `toEqual` is total only over what the fixture actually produces —
   * hence a fixture that sets every optional.
   */
  it('builds a complete candidate row — every declared field, one total assertion', async () => {
    writePeers({
      nodes: [
        storedNode({
          nodeId: 'node-full',
          labels: ['macos', 'imessage'],
          acceptsDispatch: true,
          capacity: { maxParallel: 8, active: 2, maxHeavySteps: 3, heavyActive: 1, enforcement: 'cgroup' },
          capacityAt: '2026-08-23T11:59:30.000Z',
          corpus: { version: 'v9', fetchedAt: '2026-08-23T11:55:00.000Z', scope: ['knowledge'], quarantined: 2 },
        }),
        // The deliberate non-matching second row: without it, "the builder maps this node" and "the
        // builder maps whatever row it finds first" are indistinguishable.
        storedNode({ nodeId: 'node-other', acceptsDispatch: false }),
      ],
    });

    const candidates = await build({
      connectedNodeIds: ['node-full'],
      holdsProject: holdsProjectFake(['node-full']),
    });

    expect(byId(candidates, 'node-full')).toEqual({
      nodeId: 'node-full',
      labels: ['macos', 'imessage'],
      acceptsDispatch: true,
      online: true,
      capacity: { maxParallel: 8, active: 2, maxHeavySteps: 3, heavyActive: 1, enforcement: 'cgroup' },
      holdsProject: true,
      capacityAgeMs: 30_000,
      corpusStalenessMs: 300_000,
    } satisfies PlacementCandidate);

    expect(byId(candidates, 'node-other')).toEqual(
      expect.objectContaining({ acceptsDispatch: false, online: false, holdsProject: false }),
    );
  });

  it('does not fold this hub’s pending dispatches into `active` — that adjustment is hub-dispatch’s', async () => {
    // `hub-dispatch.ts#dispatch` already adds its own pending count to `capacity.active` before
    // ranking; doing it here too would double-count between beats. The roster's number passes
    // through untouched.
    writePeers({
      nodes: [
        storedNode({ nodeId: 'node-loaded', capacity: { maxParallel: 8, active: 6, heavyActive: 0, enforcement: 'none' } }),
        storedNode({ nodeId: 'node-idle', capacity: { maxParallel: 8, active: 0, heavyActive: 0, enforcement: 'none' } }),
      ],
    });

    const candidates = await build();

    expect(byId(candidates, 'node-loaded').capacity.active).toBe(6);
    expect(byId(candidates, 'node-idle').capacity.active).toBe(0);
  });

  it('measures every candidate against ONE instant, not a clock read per row', async () => {
    // Same stamp on both rows must yield the same age; a per-row `new Date()` would drift them
    // apart under load and is what `now: Date` on the input exists to prevent.
    writePeers({
      nodes: [
        storedNode({ nodeId: 'node-1', capacityAt: '2026-08-23T11:45:00.000Z' }),
        storedNode({ nodeId: 'node-2', capacityAt: '2026-08-23T11:45:00.000Z' }),
      ],
    });

    const candidates = await build({ now: new Date('2026-08-23T12:00:00.000Z') });

    expect(byId(candidates, 'node-1').capacityAgeMs).toBe(900_000);
    expect(byId(candidates, 'node-2').capacityAgeMs).toBe(900_000);
  });

  it('reads `input.now` and never a clock of its own', async () => {
    writePeers({ nodes: [storedNode({ nodeId: 'node-a', capacityAt: '2026-08-23T11:00:00.000Z' })] });

    const early = await build({ now: new Date('2026-08-23T11:30:00.000Z') });
    const late = await build({ now: new Date('2026-08-23T13:00:00.000Z') });

    expect(byId(early, 'node-a').capacityAgeMs).toBe(1_800_000);
    expect(byId(late, 'node-a').capacityAgeMs).toBe(7_200_000);
  });

  // `ClusterCapacity` is imported for the fixture literals above; naming it here keeps the import
  // honest under `noUnusedLocals` if a future edit drops the last inline annotation.
  it('fixture capacities satisfy the contract', () => {
    const capacity: ClusterCapacity = storedNode().capacity!;
    expect(clusterCapacitySchema.parse(capacity)).toEqual(capacity);
  });
});
