import { describe, expect, it } from 'vitest';
import {
  CLUSTERING_OFF,
  DISPATCH_LOCAL,
  mayAutostartTodo,
  type TodoAutostartCluster,
  type TodoAutostartProject,
} from '../todo-autostart.ts';
import type { RunManager } from '../workflows/run.ts';
import type { TodoItem } from '../todos.ts';
import {
  armClusterAutostart,
  createHubAutostartCluster,
  createSpokeAutostartCluster,
  currentAutostartDispatch,
  currentClusterAutostart,
} from './autostart-seam.ts';

/**
 * The seam between "a todo wants to autostart" and "this cluster decides where it runs" —
 * `armClusterAutostart`/`currentClusterAutostart`/`currentAutostartDispatch` (the module-level
 * holder `TodoAutostartProject#cluster`/`#dispatch` are wired to, since both became FUNCTIONS on
 * 2026-08-24) and the two production policies, `createHubAutostartCluster` /
 * `createSpokeAutostartCluster`.
 *
 * `mayAutostartTodo` itself is exercised end to end (not stubbed) wherever a test's whole point is
 * how the guard reads a policy built by this module — the same posture `todo-autostart.test.ts`'s
 * own suite takes with `FakeHub`.
 */

/** A minimal `TodoAutostartProject` for driving `mayAutostartTodo` directly — it reads only
 *  `project.cluster()` (and `project.dataDir` for its own error text), never `manager`,
 *  `repoRoot` or `dispatch`, so those are stubbed and never expected to be touched. */
function fakeProject(cluster: () => TodoAutostartCluster | typeof CLUSTERING_OFF): TodoAutostartProject {
  return {
    repoRoot: '/tmp/does-not-matter',
    dataDir: '/tmp/does-not-matter/.ai/cezar',
    manager: {} as unknown as RunManager,
    cluster,
    dispatch: () => DISPATCH_LOCAL,
  };
}

function todo(overrides: Partial<TodoItem> = {}): TodoItem {
  return { id: 't1', summary: 'Ship it', autostart: true, ...overrides };
}

describe('cluster/autostart-seam — the module-level holder', () => {
  it('nothing armed: both answers are the single-node defaults', () => {
    expect(currentClusterAutostart()).toBe(CLUSTERING_OFF);
    expect(currentAutostartDispatch()).toBe(DISPATCH_LOCAL);
  });

  it('disposing an armed policy restores the PREVIOUS one (LIFO), not merely undefined', () => {
    expect(currentClusterAutostart()).toBe(CLUSTERING_OFF);

    const clusterA = createHubAutostartCluster('node-a');
    const disposeA = armClusterAutostart({ cluster: clusterA, dispatch: DISPATCH_LOCAL });
    try {
      expect(currentClusterAutostart()).toBe(clusterA);

      const clusterB = createHubAutostartCluster('node-b');
      const disposeB = armClusterAutostart({ cluster: clusterB, dispatch: DISPATCH_LOCAL });
      expect(currentClusterAutostart()).toBe(clusterB);

      // The load-bearing assertion: disposing the INNER arm must restore clusterA, not fall all
      // the way back to CLUSTERING_OFF — a disposer that just did `armed = undefined` would pass
      // every other assertion in this file and still strand the outer arm.
      disposeB();
      expect(currentClusterAutostart()).toBe(clusterA);
    } finally {
      disposeA();
    }

    expect(currentClusterAutostart()).toBe(CLUSTERING_OFF);
    expect(currentAutostartDispatch()).toBe(DISPATCH_LOCAL);
  });
});

describe('cluster/autostart-seam — createSpokeAutostartCluster', () => {
  it('claimStart always refuses, with a non-empty reason', async () => {
    const spoke = createSpokeAutostartCluster({
      nodeId: 'spoke-1',
      hubReachable: () => true,
      authoredHere: () => false,
    });

    const result = await spoke.claimStart(todo());

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error('unreachable — asserted above');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('a worker will not self-start the master’s work: armed + hub reachable, mayAutostartTodo refuses a replicated todo', async () => {
    const spoke = createSpokeAutostartCluster({
      nodeId: 'spoke-1',
      hubReachable: () => true,
      authoredHere: () => false,
    });
    const dispose = armClusterAutostart({ cluster: spoke, dispatch: DISPATCH_LOCAL });
    try {
      const decision = await mayAutostartTodo(fakeProject(currentClusterAutostart), todo());
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error('unreachable — asserted above');
      expect(decision.reason.length).toBeGreaterThan(0);
    } finally {
      dispose();
    }
  });
});

describe('cluster/autostart-seam — createHubAutostartCluster', () => {
  it('claimStart accepts, BUT mayAutostartTodo still refuses a todo already claimed by a different node', async () => {
    const hub = createHubAutostartCluster('hub-1');

    // The claim policy itself is unconditional acceptance — it is not where the mutual exclusion
    // lives (that is `mayAutostartTodo`'s replicated-record check, one step earlier).
    await expect(hub.claimStart(todo())).resolves.toEqual({ accepted: true, startedOn: 'hub-1' });

    // The guard this pins: a RESTARTED hub must not re-dispatch work a spoke is already running.
    // `HubDispatcher`'s own duplicate-dispatch guard is in-memory and forgets on restart
    // (hub-dispatch.ts's own docblock); the replicated `startedOn` on the record is what still
    // stands in the way, and it is read BEFORE `claimStart` is ever consulted.
    const decision = await mayAutostartTodo(
      fakeProject(() => hub),
      todo({ startedOn: 'some-spoke' }),
    );

    expect(decision).toEqual({ allowed: false, reason: 'already claimed by node some-spoke' });
  });
});
