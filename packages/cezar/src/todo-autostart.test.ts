import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from './runs/store.ts';
import type { RunManager, StartRunInput } from './workflows/run.ts';
import type { WorkflowDef } from './workflows/types.ts';
import { readTodos, todosPath, type TodoItem } from './todos.ts';
import {
  CLUSTERING_OFF,
  mayAutostartTodo,
  reconcileAutostartTodos,
  watchTodoAutostart,
  type AutostartRefusal,
  type TodoAutostartCluster,
  type TodoAutostartProject,
  type TodoClaimResult,
} from './todo-autostart.ts';
import { mayStartWithoutHub } from './cluster/dispatch.ts';
import { localCliAuthor } from './runs/task-author.ts';

/**
 * Phase 2 — `cezar todo add --start` (`.ai/specs/2026-08-19-file-tasks-from-a-running-task.md`).
 * `reconcileAutostartTodos`/`watchTodoAutostart` are the runtime hook that turns an
 * `autostart: true` todo into a run through the OWNING project's own manager, mirroring
 * `todos-start.test.ts`'s capturing-stub pattern for `RunManager` rather than spawning a real
 * agent.
 */

async function waitFor(assertion: () => void, timeoutMs = 4000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

describe('reconcileAutostartTodos', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let started: StartRunInput[];
  let project: TodoAutostartProject;

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify(todos, null, 2), 'utf8');
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todo-autostart-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    started = [];
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started.push(input);
        return store.createRun({ author: input.author, title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    project = { repoRoot, dataDir, manager, cluster: CLUSTERING_OFF };
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('starts an autostart todo and stamps startedTaskId + clears autostart on disk', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', autostart: true }]);
    await reconcileAutostartTodos(project);

    expect(started).toHaveLength(1);
    expect(started[0]?.task).toBe('Ship it');

    const [todo] = await readTodos(dataDir);
    expect(todo?.startedTaskId).toBeTruthy();
    expect(todo?.autostart).toBeUndefined();
  });

  it('ignores a todo with no autostart flag', async () => {
    writeTodos([{ id: 't1', summary: 'Just a backlog entry' }]);
    await reconcileAutostartTodos(project);
    expect(started).toHaveLength(0);
  });

  it('double-start guard: an already-started entry is never started twice', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', autostart: true, startedTaskId: 'run-already' }]);
    await reconcileAutostartTodos(project);
    expect(started).toHaveLength(0);
  });

  it('a failing todo does not block the rest of the file', async () => {
    writeTodos([
      { id: 'bad', summary: 'Boom', autostart: true, suggestedSkill: 'x'.repeat(5000) },
      { id: 'ok', summary: 'Fine', autostart: true },
    ]);
    // `resolveTodoWorkflow` never throws on an unknown skill (falls back to the default), so force a
    // failure a different way: make the manager itself throw for the first todo only.
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        if (input.task === 'Boom') throw new Error('spawn failed');
        started.push(input);
        return store.createRun({ author: input.author, title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    await reconcileAutostartTodos({ ...project, manager });
    expect(started).toHaveLength(1);
    expect(started[0]?.task).toBe('Fine');
  });

  it('two overlapping reconcile calls for the same project serialize — the todo starts exactly once', async () => {
    writeTodos([{ id: 't1', summary: 'Ship it', autostart: true }]);
    let calls = 0;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        calls += 1;
        return store.createRun({ author: input.author, title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    const raced = { ...project, manager };
    // Neither call is awaited before the second fires — reconcileAutostartTodos' own per-dataDir
    // tail is what has to keep these from both reading the file before either's markStarted lands.
    await Promise.all([reconcileAutostartTodos(raced), reconcileAutostartTodos(raced)]);
    expect(calls).toBe(1);
  });

  it("the autostarted run INHERITS the todo's author, only changing `via`", async () => {
    // No human acted, so the agent that filed the todo is the author of the run it caused
    // (spec 2026-08-21-task-author-provenance). Inheritance, not re-derivation — and `at` stays
    // the moment that agent acted, not the moment the watcher noticed.
    const filedByAgent = {
      kind: 'agent' as const,
      id: 'run_parent',
      via: 'cli-todo-add' as const,
      at: '2026-08-20T09:00:00.000Z',
      parentTaskId: 'run_parent',
      agentSessionId: 'sess_1',
    };
    writeTodos([{ id: 't1', summary: 'Ship it', autostart: true, author: filedByAgent }]);
    await reconcileAutostartTodos(project);

    expect(started[0]?.author).toEqual({ ...filedByAgent, via: 'todo-autostart' });
    expect(store.listRuns()[0]?.author).toEqual({ ...filedByAgent, via: 'todo-autostart' });
  });

  it('a legacy todo with no author degrades to `system`, never to a guess', async () => {
    writeTodos([{ id: 't2', summary: 'Filed before this shipped', autostart: true }]);
    await reconcileAutostartTodos(project);

    expect(started[0]?.author).toMatchObject({ kind: 'system', id: 'cezar', via: 'todo-autostart' });
  });
});

describe('watchTodoAutostart', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let started: StartRunInput[];
  const cleanups: Array<() => void> = [];

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify(todos, null, 2), 'utf8');
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-todo-autostart-watch-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    started = [];
  });

  afterEach(() => {
    for (const off of cleanups.splice(0)) off();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const fakeProject = (): TodoAutostartProject => {
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        started.push(input);
        return store.createRun({ author: input.author, title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;
    return { repoRoot, dataDir, manager, cluster: CLUSTERING_OFF };
  };

  it('the boot pass starts an autostart todo already sitting in the file at subscribe time', async () => {
    writeTodos([{ id: 't1', summary: 'Already flagged', autostart: true }]);
    const stop = watchTodoAutostart(fakeProject());
    cleanups.push(stop);
    await waitFor(() => expect(started).toHaveLength(1));
  });

  it('a later write to todos.json is picked up live', async () => {
    writeTodos([]);
    const stop = watchTodoAutostart(fakeProject());
    cleanups.push(stop);
    await waitFor(() => expect(started).toHaveLength(0)); // settle the boot pass first
    await fs.writeFile(
      todosPath(dataDir),
      JSON.stringify([{ id: 't2', summary: 'Filed later', autostart: true }], null, 2),
    );
    await waitFor(() => expect(started).toHaveLength(1), 6000);
  });

  it('re-subscribing the same dataDir replaces the old watch rather than stacking a second one', async () => {
    writeTodos([]);
    const first = watchTodoAutostart(fakeProject());
    const second = watchTodoAutostart(fakeProject());
    cleanups.push(second);
    // The first subscription's own unsubscribe must be a safe no-op after being superseded.
    expect(() => first()).not.toThrow();
  });
});

/**
 * Phase 3 of the cluster — the autostart guard (spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D4 · D9a · D15a · D15b; PLAN 3.2).
 * Verifications **9, 10, 11, 14**.
 *
 * **The hub is faked, not the guard.** `FakeHub` below is a linearized claim registry plus the
 * replica push the real hub performs on ack (D7: `startedOn` is written down to every node through
 * the store API). Nothing here stubs `mayAutostartTodo` itself — the tests drive
 * `reconcileAutostartTodos` end to end so an ordering bug has somewhere to show up.
 */

/** The hub's ack, replicated down. Written straight into the file because the fake hub is standing
 *  in for the replica path (`todos.ts`'s `applyHubReplica`), which is not this package's to call. */
function patchTodoOnDisk(dataDir: string, todoId: string, fields: Partial<TodoItem>): void {
  const path = todosPath(dataDir);
  if (!existsSync(path)) return;
  const items = JSON.parse(readFileSync(path, 'utf8')) as TodoItem[];
  writeFileSync(
    path,
    JSON.stringify(
      items.map((t) => (t.id === todoId ? { ...t, ...fields } : t)),
      null,
      2,
    ),
    'utf8',
  );
}

class FakeHub {
  /** todoId → the node whose claim the hub applied. This is the hub's ARRIVAL ORDER, which is the
   *  whole of the mutual exclusion (D4) — there is no lease anywhere in this class. */
  readonly claims = new Map<string, string>();
  /** Every claim ATTEMPT, so a test can prove a node asked (or, for verification 10, that it never
   *  did). Without this a "no second run" assertion passes just as well against a node that never
   *  reached the guard at all. */
  claimCalls: Array<{ nodeId: string; todoId: string }> = [];
  private readonly nodes: string[] = [];

  register(dataDir: string): void {
    this.nodes.push(dataDir);
  }

  /** Blue-green self-deploy (D15b): the hub's own store is gone and it comes back empty. */
  wipe(): void {
    this.claims.clear();
  }

  async claim(nodeId: string, todo: TodoItem): Promise<TodoClaimResult> {
    // Yield first, so two nodes claiming "concurrently" are both genuinely in flight before either
    // decides — otherwise the first caller wins by call order rather than by the hub's arbitration.
    await new Promise((r) => setImmediate(r));
    this.claimCalls.push({ nodeId, todoId: todo.id });
    const holder = this.claims.get(todo.id);
    if (holder !== undefined && holder !== nodeId) {
      return { accepted: false, reason: 'another node already holds this claim', startedOn: holder };
    }
    this.claims.set(todo.id, nodeId);
    // D7 — the ack IS the stamp, and it replicates to every node, not just the winner.
    for (const dataDir of this.nodes) patchTodoOnDisk(dataDir, todo.id, { startedOn: nodeId });
    return { accepted: true, startedOn: nodeId };
  }
}

interface FakeNode {
  nodeId: string;
  repoRoot: string;
  dataDir: string;
  store: RunStore;
  started: StartRunInput[];
  refusals: AutostartRefusal[];
  project: TodoAutostartProject;
  write(todos: TodoItem[]): void;
}

describe('cluster autostart guard — hub-confirmed claims (spec 2026-08-22-multi-node-cezar-cluster)', () => {
  const cleanup: Array<() => void> = [];

  const makeNode = (
    nodeId: string,
    options: {
      hub?: FakeHub;
      hubReachable?: boolean;
      authoredHere?: boolean;
      /** Simulates the kill in verification 11: the claim is already acknowledged when this throws. */
      startThrows?: boolean;
      /** Clustering OFF — no port at all, which is the whole of the switch. */
      clustered?: boolean;
      onStart?: (node: FakeNode) => void;
    } = {},
  ): FakeNode => {
    const repoRoot = mkdtempSync(join(tmpdir(), `cez-cluster-autostart-${nodeId}-`));
    const dataDir = join(repoRoot, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    const store = RunStore.open(dataDir);
    const started: StartRunInput[] = [];
    const refusals: AutostartRefusal[] = [];

    const node: FakeNode = {
      nodeId,
      repoRoot,
      dataDir,
      store,
      started,
      refusals,
      project: undefined as unknown as TodoAutostartProject,
      write: (todos: TodoItem[]) => writeFileSync(todosPath(dataDir), JSON.stringify(todos, null, 2), 'utf8'),
    };

    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        options.onStart?.(node);
        if (options.startThrows) throw new Error('node killed between the claim and the start');
        started.push(input);
        return store.createRun({ author: input.author, title: 't', workflow: '(inbox)', task: input.task, steps: [] });
      },
    } as unknown as RunManager;

    const hub = options.hub;
    const clustered = options.clustered ?? true;
    node.project = {
      repoRoot,
      dataDir,
      manager,
      onRefused: (r) => refusals.push(r),
      // D43: the unclustered branch STATES it. It used to spread `{}` — an absence that read as a
      // deliberate choice and was the exact shape of the production bug this suite never caught.
      cluster: clustered
        ? ({
            nodeId,
            hubReachable: () => options.hubReachable ?? true,
            authoredHere: () => options.authoredHere ?? false,
            claimStart: (todo) => {
              if (!hub) throw new Error('claimStart called with no hub wired');
              return hub.claim(nodeId, todo as TodoItem);
            },
          } satisfies TodoAutostartCluster)
        : CLUSTERING_OFF,
    };

    hub?.register(dataDir);
    cleanup.push(() => {
      store.flush();
      rmSync(repoRoot, { recursive: true, force: true });
    });
    return node;
  };

  afterEach(() => {
    for (const off of cleanup.splice(0)) off();
  });

  // ---- the negative control that matters most --------------------------------------------------

  describe('clustering OFF — behaviour is what it was before the cluster existed', () => {
    it('starts, and still stamps AFTER acting: at startRun time the entry is unstamped and still flagged', async () => {
      // The existing single-node path is act-then-stamp, and D9a changes that ordering on the
      // CLUSTER path only. Read the file from inside `startRun` — the one moment where a
      // stamp-first regression would be visible.
      let seenAtStart: TodoItem | undefined;
      const node = makeNode('node-off', {
        clustered: false,
        onStart: (n) => {
          seenAtStart = (JSON.parse(readFileSync(todosPath(n.dataDir), 'utf8')) as TodoItem[])[0];
        },
      });
      node.write([{ id: 't1', summary: 'Ship it', autostart: true }]);

      await reconcileAutostartTodos(node.project);

      expect(node.started).toHaveLength(1);
      expect(seenAtStart?.autostart).toBe(true);
      expect(seenAtStart?.startedTaskId).toBeUndefined();
      const [after] = await readTodos(node.dataDir);
      expect(after?.startedTaskId).toBeTruthy();
      expect(after?.autostart).toBeUndefined();
      expect(node.refusals).toEqual([]);
    });

    it('the guard cannot fire when off: a record carrying another node’s claim still starts', async () => {
      // The sharpest form of the control. Every field the cluster guard keys on is present and
      // says "someone else owns this" — and with no port wired none of them may gate anything,
      // because they never can on a single-node install that has simply never heard of a cluster.
      const node = makeNode('node-off-2', { clustered: false });
      node.write([
        { id: 't1', summary: 'Ship it', autostart: true, startedOn: 'node-somebody-else', pendingSince: '2026-08-22T00:00:00.000Z' },
      ]);

      await reconcileAutostartTodos(node.project);

      expect(node.started).toHaveLength(1);
      expect(node.refusals).toEqual([]);
    });

    it('mayAutostartTodo is a no-op that allows', async () => {
      const node = makeNode('node-off-3', { clustered: false });
      await expect(
        mayAutostartTodo(node.project, { id: 't1', summary: 'Ship it', autostart: true, startedOn: 'node-x' }),
      ).resolves.toEqual({ allowed: true });
    });
  });

  // ---- verification 9 --------------------------------------------------------------------------

  describe('verification 9 — exactly-once start', () => {
    it('one autostart todo replicated to two nodes produces exactly ONE run', async () => {
      const hub = new FakeHub();
      const a = makeNode('node-a', { hub });
      const b = makeNode('node-b', { hub });
      const todo: TodoItem = { id: 'shared-1', summary: 'Ship it once', autostart: true };
      a.write([todo]);
      b.write([todo]);

      await Promise.all([reconcileAutostartTodos(a.project), reconcileAutostartTodos(b.project)]);

      expect(a.started.length + b.started.length).toBe(1);
      // Both nodes actually TRIED — otherwise "exactly one run" would pass against a test in which
      // the second node never reached the guard, and the guard would be untested.
      expect(hub.claimCalls.map((c) => c.nodeId).sort()).toEqual(['node-a', 'node-b']);
      // The loser refused with a stated reason naming the winner (D15a: never a silent skip).
      const loser = a.started.length === 1 ? b : a;
      const winner = a.started.length === 1 ? a : b;
      expect(loser.refusals).toHaveLength(1);
      expect(loser.refusals[0]?.reason).toContain(winner.nodeId);
      expect(loser.refusals[0]?.todoId).toBe('shared-1');
    });

    it('confirm BEFORE start: the claim is already acknowledged by the time startRun is called', async () => {
      const hub = new FakeHub();
      let claimsAtStart = -1;
      const a = makeNode('node-a', { hub, onStart: () => (claimsAtStart = hub.claims.size) });
      a.write([{ id: 'shared-2', summary: 'Ship it', autostart: true }]);

      await reconcileAutostartTodos(a.project);

      expect(a.started).toHaveLength(1);
      expect(claimsAtStart).toBe(1);
      expect(hub.claims.get('shared-2')).toBe('node-a');
    });
  });

  // ---- verification 10 -------------------------------------------------------------------------

  describe('verification 10 — exactly-once across a hub lease-store wipe (blue-green deploy)', () => {
    it('node B does not start a second run, and never even asks the wiped hub', async () => {
      const hub = new FakeHub();
      const a = makeNode('node-a', { hub });
      const b = makeNode('node-b', { hub });
      const todo: TodoItem = { id: 'shared-3', summary: 'Ship it once', autostart: true };
      a.write([todo]);
      b.write([todo]);

      await reconcileAutostartTodos(a.project);
      expect(a.started).toHaveLength(1);
      const [startedOnA] = await readTodos(a.dataDir);
      expect(startedOnA?.startedTaskId).toBeTruthy();

      // The replica push of A's completed start (the ordinary optimistic op, post-start).
      patchTodoOnDisk(b.dataDir, 'shared-3', { startedTaskId: startedOnA?.startedTaskId });

      // ~10 blue-green restarts a day: the hub's store is gone and it comes back empty.
      hub.wipe();
      hub.claimCalls = [];

      await reconcileAutostartTodos(b.project);

      expect(b.started).toHaveLength(0);
      // The durable key is the REPLICATED STAMP, not a lease: a wiped hub is never consulted, so
      // wiping it cannot grant the same work twice.
      expect(hub.claimCalls).toEqual([]);

      const [onB] = await readTodos(b.dataDir);
      await expect(mayAutostartTodo(b.project, onB as TodoItem)).resolves.toEqual({
        allowed: false,
        reason: `already started as run ${startedOnA?.startedTaskId}`,
      });
    });

    it('negative control: the SAME wiped hub still grants an unstamped todo', async () => {
      // Without this, "node B refused" would pass equally well against a hub that refuses
      // everything after a wipe — which would be a different (and much worse) bug.
      const hub = new FakeHub();
      const b = makeNode('node-b', { hub });
      b.write([
        { id: 'stamped', summary: 'Already run elsewhere', autostart: true, startedTaskId: 'run-from-node-a' },
        { id: 'fresh', summary: 'Nobody has claimed this', autostart: true },
      ]);
      hub.wipe();

      await reconcileAutostartTodos(b.project);

      expect(b.started.map((s) => s.task)).toEqual(['Nobody has claimed this']);
      expect(hub.claimCalls).toEqual([{ nodeId: 'node-b', todoId: 'fresh' }]);
    });

    it('the crash-window stamp survives the wipe too: startedOn alone still refuses node B', async () => {
      const hub = new FakeHub();
      const b = makeNode('node-b', { hub });
      b.write([{ id: 'claimed-elsewhere', summary: 'Claimed, not yet started', autostart: true, startedOn: 'node-a' }]);
      hub.wipe();

      await reconcileAutostartTodos(b.project);

      expect(b.started).toHaveLength(0);
      expect(hub.claimCalls).toEqual([]);
      expect(b.refusals[0]?.reason).toBe('already claimed by node node-a');
    });
  });

  // ---- verification 11 -------------------------------------------------------------------------

  describe('verification 11 — stamp-before-start ordering', () => {
    it('killed between the confirmed claim and startRun: stamped, un-started, and no second node picks it up', async () => {
      const hub = new FakeHub();
      const a = makeNode('node-a', { hub, startThrows: true });
      const b = makeNode('node-b', { hub });
      const todo: TodoItem = { id: 'shared-4', summary: 'Ship it once', autostart: true };
      a.write([todo]);
      b.write([todo]);

      // `reconcileAutostartTodos` swallows a per-todo failure by design — the kill is the throw.
      await reconcileAutostartTodos(a.project);

      expect(a.started).toHaveLength(0);
      const [onA] = await readTodos(a.dataDir);
      // Stamped …
      expect(onA?.startedOn).toBe('node-a');
      expect(hub.claims.get('shared-4')).toBe('node-a');
      // … and un-started. A VISIBLE PENDING START, never a duplicate.
      expect(onA?.startedTaskId).toBeUndefined();
      expect(onA?.autostart).toBe(true);

      // No second node picks it up — the hub replicated the claim down to B on ack.
      await reconcileAutostartTodos(b.project);
      expect(b.started).toHaveLength(0);
      expect(b.refusals[0]?.reason).toBe('already claimed by node node-a');
      expect(hub.claimCalls.filter((c) => c.nodeId === 'node-b')).toEqual([]);
    });

    it('the node that holds the claim resumes it, and does not claim a second time', async () => {
      const hub = new FakeHub();
      const a = makeNode('node-a', { hub });
      a.write([{ id: 'shared-5', summary: 'Resume me', autostart: true, startedOn: 'node-a' }]);

      await reconcileAutostartTodos(a.project);

      expect(a.started).toHaveLength(1);
      expect(hub.claimCalls).toEqual([]);
    });
  });

  // ---- verification 14, both halves ------------------------------------------------------------

  describe('verification 14 — hub unreachable (D15a scopes, not an ordering)', () => {
    it('half 1: a todo this node authored still autostarts with the hub down, and never waits on it', async () => {
      const hub = new FakeHub();
      const a = makeNode('node-a', { hub, hubReachable: false, authoredHere: true });
      a.write([{ id: 'mine', summary: 'Filed here', autostart: true }]);

      await reconcileAutostartTodos(a.project);

      expect(a.started).toHaveLength(1);
      expect(hub.claimCalls).toEqual([]);
      expect(a.refusals).toEqual([]);
    });

    it('half 2: a REPLICATED todo refuses, with the stated reason', async () => {
      const hub = new FakeHub();
      const b = makeNode('node-b', { hub, hubReachable: false, authoredHere: false });
      b.write([{ id: 'theirs', summary: 'Filed on another node', autostart: true }]);

      await reconcileAutostartTodos(b.project);

      expect(b.started).toHaveLength(0);
      expect(b.refusals).toEqual([
        {
          dataDir: b.dataDir,
          todoId: 'theirs',
          summary: 'Filed on another node',
          reason: 'waiting for the hub to confirm the claim',
        },
      ]);
    });

    it('half 1 and half 2 in ONE pass — refuse-everything and start-everything both fail here', async () => {
      // Each half looks correct if you only test the other, so assert them against one file: the
      // authored-here entry starts and the replicated one refuses, in the same reconcile.
      const hub = new FakeHub();
      const node = makeNode('node-mixed', { hub, hubReachable: false, authoredHere: false });
      node.project = {
        ...node.project,
        cluster: {
          ...(node.project.cluster as TodoAutostartCluster),
          authoredHere: (todo) => todo.id === 'mine',
        },
      };
      node.write([
        { id: 'mine', summary: 'Filed here', autostart: true },
        { id: 'theirs', summary: 'Filed on another node', autostart: true },
      ]);

      await reconcileAutostartTodos(node.project);

      expect(node.started.map((s) => s.task)).toEqual(['Filed here']);
      expect(node.refusals.map((r) => r.todoId)).toEqual(['theirs']);
    });

    it("the human half of D15a is untouched by this module: a person's ▶ Run proceeds with the hub down", async () => {
      // `mayStartWithoutHub` is the ONE copy of the scope split, and this module consumes it rather
      // than re-deciding. Asserting the human branch here is what keeps the two halves from drifting
      // apart: if someone ever narrowed that function to refuse everything while offline, the
      // autostart tests above would still pass and this one would not.
      expect(mayStartWithoutHub({ trigger: 'human', authoredHere: false })).toEqual({ allowed: true });
      expect(mayStartWithoutHub({ trigger: 'autostart', authoredHere: true })).toEqual({ allowed: true });
      expect(mayStartWithoutHub({ trigger: 'autostart', authoredHere: false })).toEqual({
        allowed: false,
        reason: 'waiting for the hub to confirm the claim',
      });
    });
  });

  // ---- D6 --------------------------------------------------------------------------------------

  it('a tombstoned autostart todo replicated from another node is never started', async () => {
    // A delete is a tombstone, never a removal (D6), so a todo deleted elsewhere arrives here still
    // carrying `autostart: true`. Starting the work somebody just deleted is the bug this skips.
    const hub = new FakeHub();
    const b = makeNode('node-b', { hub });
    b.write([
      { id: 'deleted', summary: 'Deleted on the hub', autostart: true, tombstone: { at: '2026-08-22T10:00:00.000Z' } },
      { id: 'alive', summary: 'Still wanted', autostart: true },
    ]);

    await reconcileAutostartTodos(b.project);

    expect(b.started.map((s) => s.task)).toEqual(['Still wanted']);
    expect(hub.claimCalls).toEqual([{ nodeId: 'node-b', todoId: 'alive' }]);
  });
});

/**
 * D43 — setting `CEZ_CLUSTER=1` started the same todo on every reconcile pass, forever.
 *
 * These drive the REAL `markStarted`, with `CEZ_CLUSTER` genuinely set, and no cluster seam wired —
 * which is precisely the production configuration that produced the loop. Nothing is mocked: the
 * refusal comes from `todos.ts` reading the environment and finding no `confirmStart`, exactly as it
 * does on a box where someone sets the flag.
 *
 * The shape of the bug is worth keeping in the test names: `reconcileAutostartTodosOnce` keys on
 * `startedTaskId`, and the refusal it races is defined to write NOTHING — so the field that says
 * "already handled" is the one the refusal withholds, and every pass saw a fresh-looking row.
 */
describe('todo autostart — a refused stamp must not restart the run (D43)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let runIds: string[];
  let project: TodoAutostartProject;
  const savedFlag = process.env.CEZ_CLUSTER;

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(todosPath(dataDir), JSON.stringify(todos, null, 2), 'utf8');
  };
  const readFile1 = () => readTodos(dataDir).then((t) => t[0]!);

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-d43-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    runIds = [];
    const manager = {
      startRun: (_w: WorkflowDef, input: StartRunInput) => {
        const run = store.createRun({
          author: input.author,
          title: 't',
          workflow: '(inbox)',
          task: input.task,
          steps: [],
        });
        runIds.push(run.id);
        return run;
      },
    } as unknown as RunManager;
    project = { repoRoot, dataDir, manager, cluster: CLUSTERING_OFF };
    writeTodos([{ id: 't1', summary: 'do the thing', autostart: true } as TodoItem]);
  });

  afterEach(() => {
    store.flush();
    if (savedFlag === undefined) delete process.env.CEZ_CLUSTER;
    else process.env.CEZ_CLUSTER = savedFlag;
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('starts the run ONCE across three passes when the stamp is refused — the loop itself', async () => {
    process.env.CEZ_CLUSTER = '1'; // `markStarted` now refuses `hub-unconfirmed` and writes nothing

    await reconcileAutostartTodos(project);
    await reconcileAutostartTodos(project);
    await reconcileAutostartTodos(project);

    // Measured before the fix: ["run-1","run-2","run-3"].
    expect(runIds).toHaveLength(1);
    // ...and the record genuinely was never stamped, so this is not passing because the ordinary
    // `startedTaskId` guard caught it. Without that, "1 run" could mean the refusal never happened.
    const todo = await readFile1();
    expect(todo.startedTaskId).toBeUndefined();
    expect(todo.autostart).toBe(true);
  });

  it('retries the STAMP with the run that already exists, and converges once the write side can confirm', async () => {
    process.env.CEZ_CLUSTER = '1';
    await reconcileAutostartTodos(project);
    expect(runIds).toHaveLength(1);
    const firstRun = runIds[0]!;

    // The condition clears — the same shape as an operator unsetting the flag, or a write side that
    // can finally confirm. The next pass owes a stamp, not a run.
    delete process.env.CEZ_CLUSTER;
    await reconcileAutostartTodos(project);

    expect(runIds).toHaveLength(1); // still ONE run — never a second
    const todo = await readFile1();
    // The stamp names the run that actually exists. A fix that started a fresh run here would also
    // produce a stamped record, so asserting the ID is what separates the two.
    expect(todo.startedTaskId).toBe(firstRun);
    expect(todo.autostart).toBeUndefined();
  });

  it('a refused stamp is REPORTED, not swallowed — it names the run that exists without a record', async () => {
    process.env.CEZ_CLUSTER = '1';
    const refusals: AutostartRefusal[] = [];
    await reconcileAutostartTodos({ ...project, onRefused: (r) => refusals.push(r) });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.todoId).toBe('t1');
    expect(refusals[0]?.reason).toContain(runIds[0]!);
    expect(refusals[0]?.reason).toContain('could not be stamped');
  });

  it('CONTROL — with the flag unset nothing above changes the live path: one run, stamped, autostart cleared', async () => {
    delete process.env.CEZ_CLUSTER;

    await reconcileAutostartTodos(project);
    await reconcileAutostartTodos(project);

    expect(runIds).toHaveLength(1);
    const todo = await readFile1();
    expect(todo.startedTaskId).toBe(runIds[0]);
    expect(todo.autostart).toBeUndefined();
  });

  it('a project that omits the cluster switch fails LOUDLY rather than defaulting to off', async () => {
    process.env.CEZ_CLUSTER = '1';
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      // Only reachable by defeating the type — which is the point: the field is required so this
      // state cannot be constructed by a caller, and the old silent "absent means off" is gone.
      await reconcileAutostartTodos({ repoRoot, dataDir, manager: project.manager } as TodoAutostartProject);
    } finally {
      console.warn = warn;
    }

    expect(runIds).toHaveLength(0); // nothing started on an unstated switch
    expect(lines.join('\n')).toContain('CLUSTERING_OFF');
  });
});
