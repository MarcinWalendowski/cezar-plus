import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredClusterNodeIdentity, WorkflowDef } from '@loki-labs/better-cezar-contract';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { workspaceConfigPath } from '../paths.ts';
import { peersPath } from './peers.ts';
import { createHubAutostartDispatch, type HubAutostartDispatchDeps } from './hub-autostart-dispatch.ts';
import type { HubDispatchAttempt, HubDispatcher } from './hub-dispatch.ts';
import type { TodoItem } from '../todos.ts';

/**
 * The hub's adapter between the autostart reconcile pass and the placement stack — the caller
 * `createHubDispatcher` never had (`hub-autostart-dispatch.ts`'s own docblock). `buildPlacementCandidates`
 * and `placeRun`/`buildDispatch` are already fully covered by their own suites (`hub-candidates.test.ts`,
 * `placement.test.ts`, `dispatch.test.ts`), so nothing here re-tests ranking — `deps.dispatcher` is
 * FAKED so every test asserts only what THIS module does with the dispatcher's answer.
 */
describe('cluster/hub-autostart-dispatch', () => {
  let home: string;
  let repoRoot: string;

  beforeEach(() => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-hub-autostart-dispatch-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-hub-autostart-dispatch-repo-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function env(): NodeJS.ProcessEnv {
    return { CEZ_HOME: home };
  }

  function writeConfig(projects: Array<{ id: string; root: string }>): void {
    const path = workspaceConfigPath(env());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ projects }), 'utf8');
  }

  function writePeers(pairings: unknown[]): void {
    const path = peersPath(env());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ nodes: [], pairings }), 'utf8');
  }

  function identity(overrides: Partial<StoredClusterNodeIdentity> = {}): StoredClusterNodeIdentity {
    return {
      nodeId: 'hub-1',
      nodeName: 'Hub',
      createdAt: '2026-08-01T00:00:00.000Z',
      role: 'hub',
      acceptsDispatch: true,
      labels: [],
      ...overrides,
    };
  }

  function semaphore(): WorkspaceSemaphore {
    return new WorkspaceSemaphore({ initial: { maxParallel: 4 } });
  }

  const workflow: WorkflowDef = { name: 'quick-task', steps: [], source: 'built-in' };
  const todo: TodoItem = { id: 'todo-1', summary: 'ship it', autostart: true };

  /** Fakes only `dispatch()` — nothing here calls the correlation/sweep members of `HubDispatcher`. */
  function fakeDispatcher(
    impl: () => HubDispatchAttempt | Promise<HubDispatchAttempt>,
  ): { dispatch: ReturnType<typeof vi.fn>; hub: HubDispatcher } {
    const dispatch = vi.fn(impl);
    return { dispatch, hub: { dispatch } as unknown as HubDispatcher };
  }

  function deps(overrides: Partial<HubAutostartDispatchDeps> & { dispatcher: HubDispatcher }): HubAutostartDispatchDeps {
    return {
      identity: identity(),
      semaphore: semaphore(),
      connectedNodeIds: () => [],
      env: env(),
      warn: vi.fn(),
      ...overrides,
    };
  }

  it('an UNPAIRED project (pairing exists but never confirmed) places LOCAL, and the dispatcher is never consulted', async () => {
    writeConfig([{ id: 'proj-local', root: repoRoot }]);
    writePeers([
      {
        projectKey: 'proj-key-1',
        // No `confirmedAt` on the hub's own member — a PROPOSED pairing, inert, replicates nothing.
        byNode: { 'hub-1': { nodeId: 'hub-1', projectId: 'proj-local' } },
      },
    ]);
    const { dispatch, hub } = fakeDispatcher(() => {
      throw new Error('must not be called for an unpaired project');
    });

    const place = createHubAutostartDispatch(deps({ dispatcher: hub }));
    const outcome = await place.place({ todo, workflow, repoRoot, dataDir: join(repoRoot, '.ai/cezar') });

    expect(outcome).toEqual({ start: 'local' });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('a REMOTE placement carries the DISPATCHER’S OWN dispatchId and nodeId, not a freshly minted one', async () => {
    writeConfig([{ id: 'proj-local', root: repoRoot }]);
    writePeers([
      {
        projectKey: 'proj-key-1',
        byNode: {
          'hub-1': { nodeId: 'hub-1', projectId: 'proj-local', confirmedAt: '2026-08-23T00:00:00.000Z' },
        },
      },
    ]);
    const { hub } = fakeDispatcher(() => ({
      placement: { status: 'placed', nodeId: 'node-b' },
      dispatch: { dispatchId: 'disp-99', nodeId: 'node-b', sent: true },
    }));

    const place = createHubAutostartDispatch(deps({ dispatcher: hub, connectedNodeIds: () => ['node-b'] }));
    const outcome = await place.place({ todo, workflow, repoRoot, dataDir: join(repoRoot, '.ai/cezar') });

    expect(outcome).toEqual({ start: 'remote', nodeId: 'node-b', dispatchId: 'disp-99' });
  });

  it('a LOCAL placement (the placed node IS this hub) starts here — no dispatch id to carry', async () => {
    writeConfig([{ id: 'proj-local', root: repoRoot }]);
    writePeers([
      {
        projectKey: 'proj-key-1',
        byNode: {
          'hub-1': { nodeId: 'hub-1', projectId: 'proj-local', confirmedAt: '2026-08-23T00:00:00.000Z' },
        },
      },
    ]);
    const { hub } = fakeDispatcher(() => ({ placement: { status: 'placed', nodeId: 'hub-1' } }));

    const place = createHubAutostartDispatch(deps({ dispatcher: hub }));
    const outcome = await place.place({ todo, workflow, repoRoot, dataDir: join(repoRoot, '.ai/cezar') });

    expect(outcome).toEqual({ start: 'local' });
  });

  it('a DECLINED dispatch (already-dispatched) becomes {start: "none"} naming the EXISTING dispatch, not a new reason', async () => {
    writeConfig([{ id: 'proj-local', root: repoRoot }]);
    writePeers([
      {
        projectKey: 'proj-key-1',
        byNode: {
          'hub-1': { nodeId: 'hub-1', projectId: 'proj-local', confirmedAt: '2026-08-23T00:00:00.000Z' },
        },
      },
    ]);
    const { hub } = fakeDispatcher(() => ({
      declined: {
        reason: 'already-dispatched',
        existing: {
          dispatchId: 'disp-existing',
          todoId: 'todo-1',
          projectKey: 'proj-key-1',
          nodeId: 'node-c',
          sentAt: '2026-08-23T00:00:00.000Z',
          status: 'pending',
        },
      },
    }));

    const place = createHubAutostartDispatch(deps({ dispatcher: hub }));
    const outcome = await place.place({ todo, workflow, repoRoot, dataDir: join(repoRoot, '.ai/cezar') });

    expect(outcome.start).toBe('none');
    if (outcome.start !== 'none') throw new Error('unreachable — asserted above');
    expect(outcome.reason).toContain('disp-existing');
    expect(outcome.reason).toContain('node-c');
  });

  it('a BLOCKED placement becomes {start: "none"} naming the blocking run', async () => {
    writeConfig([{ id: 'proj-local', root: repoRoot }]);
    writePeers([
      {
        projectKey: 'proj-key-1',
        byNode: {
          'hub-1': { nodeId: 'hub-1', projectId: 'proj-local', confirmedAt: '2026-08-23T00:00:00.000Z' },
        },
      },
    ]);
    const { hub } = fakeDispatcher(() => ({
      placement: {
        status: 'blocked',
        blockedBy: { runId: 'run-42', nodeId: 'node-b', paths: [] },
      },
    }));

    const place = createHubAutostartDispatch(deps({ dispatcher: hub }));
    const outcome = await place.place({ todo, workflow, repoRoot, dataDir: join(repoRoot, '.ai/cezar') });

    expect(outcome.start).toBe('none');
    if (outcome.start !== 'none') throw new Error('unreachable — asserted above');
    expect(outcome.reason).toContain('run-42');
    expect(outcome.reason).toContain('node-b');
  });
});
