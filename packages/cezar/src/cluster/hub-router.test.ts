import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_PROTOCOL,
  type ClusterFreshnessFrame,
  type ClusterHelloFrame,
  type ClusterOpsFrame,
  type ClusterPresenceFrame,
  type ClusterRelayFrame,
  type StoredClusterNode,
  type StoredClusterNodeIdentity,
} from '@loki-labs/better-cezar-contract';
import { createHubFrameRouter } from './hub-router.ts';
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

  function router(overrides: { warn?: (m: string) => void } = {}) {
    return createHubFrameRouter({ identity: hubIdentity(), env: env(), warn: overrides.warn });
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

    it('does not itself gate on a roster row with disabledAt set — the UPGRADE already refused before onFrame could run (D22)', async () => {
      await upsertNode(makeStoredNode({ nodeId: 'node-a', disabledAt: new Date().toISOString() }), { env: env() });
      const replies = await router()('node-a', helloFrame({ nodeId: 'node-a' }));
      expect(replies[0]?.type).toBe('welcome');
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
