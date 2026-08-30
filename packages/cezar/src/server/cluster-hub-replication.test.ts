import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterDownlinkFrame, ClusterOp } from '@loki-labs/cezar-plus-contract';
import { ensureNodeIdentity } from '../cluster/node-identity.ts';
import { applyPairingAction } from '../cluster/peers.ts';
import { atomicWriteJsonSync, defaultWorkspaceConfig } from '../workspace/config.ts';
import { workspaceConfigPath } from '../paths.ts';
import { readTodos } from '../todos.ts';
import { buildHubReplication } from './cluster-routes.ts';

/**
 * Unit coverage for `buildHubReplication` (B3) — the deps-construction half of the deliverable.
 * `cluster-link-activation.test.ts`'s "a real ops frame is replicated end to end" case is the OTHER
 * half: it proves `startClusterRuntime` actually calls this function, which nothing here can see
 * (this file never touches `startClusterRuntime`). Both are required — see this repo's own D24
 * lesson, restated in `buildHubReplication`'s docblock: a correct test of a function production may
 * not call proves nothing about production.
 *
 * The hardest decision in B3 is that `applyOp` resolves its dataDir PER OP rather than once, from
 * the op's own `scope`/`projectKey` — never the frame's. The two-project setup below exists
 * entirely to give that decision something to fail: **the required mutation is replacing the
 * per-op `resolveHubTodosRoot(op.projectKey, ...)` call with a closure fixed to one project's
 * dataDir** (matching what a naive `createHubApplyOp(dataDir)` adapter would do). That mutation was
 * applied by hand against a scratchpad backup, run against this file alone, confirmed RED (project
 * A's write landed in project B's `todos.json` instead), and reverted — see the B3 implementation
 * report for the quoted assertion. It is not encoded as a toggle in this file because "swap one
 * project resolution for a fixed one" is a source-level substitution, not a data variation this
 * suite can parametrize.
 */
describe('buildHubReplication', () => {
  let home: string;
  let projectRootA: string;
  let projectRootB: string;
  let env: NodeJS.ProcessEnv;
  let hubNodeId: string;
  const warn = vi.fn();

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-hub-repl-home-'));
    projectRootA = mkdtempSync(join(tmpdir(), 'cez-hub-repl-a-'));
    projectRootB = mkdtempSync(join(tmpdir(), 'cez-hub-repl-b-'));
    mkdirSync(join(projectRootA, '.ai/cezar'), { recursive: true });
    mkdirSync(join(projectRootB, '.ai/cezar'), { recursive: true });
    env = { ...process.env, CEZ_HOME: home };
    warn.mockReset();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRootA, { recursive: true, force: true });
    rmSync(projectRootB, { recursive: true, force: true });
  });

  /** Mints a hub identity in this test's `env`-pinned home and registers `projects` as this hub's
   *  own local workspace registry — the set `resolveHubTodosRoot` resolves `projectId` against.
   *  Matches `cluster-routes.test.ts`'s `seedHubWorkspace` helper exactly (D21 test setup). */
  async function seedHubWorkspace(projects: ReadonlyArray<{ id: string; root: string }>): Promise<string> {
    const identity = await ensureNodeIdentity({ role: 'hub' }, { env });
    const config = {
      ...defaultWorkspaceConfig(),
      projects: projects.map((p) => ({
        id: p.id,
        root: p.root,
        name: '',
        addedAt: '',
        lastOpenedAt: '',
        source: 'local' as const,
      })),
    };
    atomicWriteJsonSync(workspaceConfigPath(env), config);
    return identity.nodeId;
  }

  /** Confirms BOTH sides of a pairing — the hub's own local `projectId` AND the caller node — the
   *  two-sided check `resolveHubTodosRoot`'s own doc spells out. */
  async function confirmPairing(projectKey: string, hubProjectId: string, callerNodeId: string): Promise<void> {
    await applyPairingAction(projectKey, { action: 'confirm', nodeId: hubNodeId, projectId: hubProjectId }, { env });
    await applyPairingAction(
      projectKey,
      { action: 'confirm', nodeId: callerNodeId, projectId: `${hubProjectId}-spoke-side` },
      { env },
    );
  }

  function upsertOp(overrides: Partial<ClusterOp> & Pick<ClusterOp, 'opId' | 'entityId'>): ClusterOp & { hubSeq: number } {
    return {
      nodeId: 'spoke-1',
      ts: new Date().toISOString(),
      scope: 'project',
      entity: 'todo',
      op: 'upsert',
      fields: { summary: 'a real row' },
      hubSeq: 1,
      ...overrides,
    } as ClusterOp & { hubSeq: number };
  }

  it('applyOp for project A writes into A\'s todos.json and nothing into B\'s, and vice versa', async () => {
    hubNodeId = await seedHubWorkspace([
      { id: 'proj-a', root: projectRootA },
      { id: 'proj-b', root: projectRootB },
    ]);
    await confirmPairing('project-a', 'proj-a', 'spoke-1');
    await confirmPairing('project-b', 'proj-b', 'spoke-1');

    const replication = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => undefined,
    );

    const outcomeA = await replication.applyOp(
      upsertOp({ opId: 'op-a-1', entityId: 'row-a', projectKey: 'project-a', fields: { summary: 'lives in A' } }),
    );
    expect(outcomeA).toEqual({ accepted: true });

    const rowsA = await readTodos(join(projectRootA, '.ai/cezar'));
    const rowsB = await readTodos(join(projectRootB, '.ai/cezar'));
    expect(rowsA.map((r) => r.id)).toEqual(['row-a']);
    expect(rowsA[0]?.summary).toBe('lives in A');
    expect(rowsB).toEqual([]); // the mutation this test exists to catch would land it here instead

    const outcomeB = await replication.applyOp(
      upsertOp({ opId: 'op-b-1', entityId: 'row-b', projectKey: 'project-b', hubSeq: 2, fields: { summary: 'lives in B' } }),
    );
    expect(outcomeB).toEqual({ accepted: true });

    const rowsA2 = await readTodos(join(projectRootA, '.ai/cezar'));
    const rowsB2 = await readTodos(join(projectRootB, '.ai/cezar'));
    expect(rowsA2.map((r) => r.id)).toEqual(['row-a']); // unchanged by B's write
    expect(rowsB2.map((r) => r.id)).toEqual(['row-b']);
    expect(rowsB2[0]?.summary).toBe('lives in B');
  });

  it('throws for scope "workspace" — no workspace-scoped store exists yet', async () => {
    hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
    const replication = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => undefined,
    );

    await expect(
      replication.applyOp({ ...upsertOp({ opId: 'op-ws-1', entityId: 'row-x' }), scope: 'workspace', projectKey: undefined }),
    ).rejects.toThrow(/workspace-scoped store exists/);
  });

  it('throws for an unknown projectKey — no pairing row names it at all', async () => {
    hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
    const replication = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => undefined,
    );

    await expect(
      replication.applyOp(upsertOp({ opId: 'op-unk-1', entityId: 'row-x', projectKey: 'never-registered' })),
    ).rejects.toThrow(/not confirmed-paired/);
  });

  it('throws when the pairing is confirmed by the caller but not by this hub', async () => {
    hubNodeId = await seedHubWorkspace([{ id: 'proj-a', root: projectRootA }]);
    // Only the CALLER side confirms — the hub's own side of the pairing never does, matching
    // `resolveHubTodosRoot`'s two-sided requirement.
    await applyPairingAction('project-a', { action: 'confirm', nodeId: 'spoke-1', projectId: 'spoke-local-id' }, { env });

    const replication = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => undefined,
    );

    await expect(
      replication.applyOp(upsertOp({ opId: 'op-half-1', entityId: 'row-x', projectKey: 'project-a' })),
    ).rejects.toThrow(/not confirmed-paired/);
  });

  it('sendTo and connectedNodes delegate through the linkServer getter, and degrade safely before it resolves', () => {
    hubNodeId = 'hub-1';
    const notYetConnected = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => undefined,
    );
    expect(notYetConnected.sendTo('spoke-1', { type: 'ack', results: [] } as unknown as ClusterDownlinkFrame)).toBe(false);
    expect(notYetConnected.connectedNodes()).toEqual([]);

    const sent: Array<[string, unknown]> = [];
    const fakeLink = {
      send: (nodeId: string, frame: unknown) => {
        sent.push([nodeId, frame]);
        return true;
      },
      connectedNodes: () => ['spoke-1'],
    };
    const connected = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => fakeLink as never,
    );
    const frame = { type: 'ack', results: [] } as unknown as ClusterDownlinkFrame;
    expect(connected.sendTo('spoke-1', frame)).toBe(true);
    expect(sent).toEqual([['spoke-1', frame]]);
    expect(connected.connectedNodes()).toEqual(['spoke-1']);
  });

  /**
   * B4's ONE production read, and the only side that can guard its argument order.
   *
   * **Why a positive case is the only thing that works here.** `ClusterNodeId` and
   * `ClusterProjectKey` are both plain `z.string()` aliases (`packages/contract/src/cluster.ts`),
   * not branded, so `resolveHubTodosRoot(nodeId, projectKey, env)` — the two swapped — **typechecks
   * silently**. A swap looks for a pairing whose `projectKey` equals a node id, finds none, and
   * returns `undefined` for EVERY project; `hub-router.ts` faithfully reports that as a refusal and
   * ships `resumeFrom: []` on every handshake, forever. That is exactly the "looks implemented,
   * replicates nothing" failure this increment exists to end, rebuilt one layer up.
   *
   * So every NEGATIVE assertion about this function is worthless as a guard: a swap refuses
   * everything, so "a refused project returns undefined" still passes. Only a case that demands
   * real records back can move. `hub-router.test.ts`'s M-C mutation guards the ROUTER's call into
   * this dep; it cannot reach this call, because those tests inject a fake dep.
   */
  it('readTodosFor returns the entitled project\'s records — the case an argument swap breaks', async () => {
    hubNodeId = await seedHubWorkspace([
      { id: 'proj-a', root: projectRootA },
      { id: 'proj-b', root: projectRootB },
    ]);
    await confirmPairing('project-a', 'proj-a', 'spoke-1');

    const replication = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => undefined,
    );

    // Seeded through the production write path, not by hand-writing todos.json, so this asserts
    // against whatever `applyOp` actually persists rather than a shape this test invented.
    await replication.applyOp(
      upsertOp({ opId: 'op-seed', entityId: 'row-a', projectKey: 'project-a', fields: { summary: 'replay me' } }),
    );

    const rows = await replication.readTodosFor?.('project-a', 'spoke-1');
    // NON-ZERO FLOOR. `toEqual([...])` on an empty array would be satisfied by a fixture that
    // never wrote anything, which is the vacuous form of this test.
    expect(rows).toBeDefined();
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.id).toBe('row-a');
    expect(rows?.[0]?.summary).toBe('replay me');
  });

  it('readTodosFor distinguishes an ENTITLED-but-empty project ([]) from a REFUSED one (undefined)', async () => {
    hubNodeId = await seedHubWorkspace([
      { id: 'proj-a', root: projectRootA },
      { id: 'proj-b', root: projectRootB },
    ]);
    await confirmPairing('project-a', 'proj-a', 'spoke-1');
    // `project-b` is registered on this hub but never paired with spoke-1.

    const replication = buildHubReplication(
      { nodeId: hubNodeId, nodeName: hubNodeId, createdAt: new Date().toISOString(), role: 'hub', acceptsDispatch: false, labels: [] },
      env,
      warn,
      () => undefined,
    );

    // Entitled, nothing written yet. MUST be `[]`, never `undefined`: `hub-router.ts` gives `[]` a
    // `resumeFrom` entry ("paired, and you are caught up") and gives `undefined` none at all
    // ("not yours to resume"). Collapsing the two turns "caught up" into "refused" silently.
    await expect(replication.readTodosFor?.('project-a', 'spoke-1')).resolves.toEqual([]);

    // Refused: confirmed by the hub for its own side, never confirmed for this node.
    await expect(replication.readTodosFor?.('project-b', 'spoke-1')).resolves.toBeUndefined();
    // And a project key no pairing row names at all.
    await expect(replication.readTodosFor?.('project-nonexistent', 'spoke-1')).resolves.toBeUndefined();
  });
});
