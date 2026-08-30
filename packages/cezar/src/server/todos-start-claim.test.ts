import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import type { TodoItem, TodoStartOptions } from '../todos.ts';
import { CLUSTERING_OFF, type TodoAutostartDispatch } from '../todo-autostart.ts';
import { armClusterAutostart } from '../cluster/autostart-seam.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * **`POST /todos/:id/start` records its claim, so one press is one run.**
 * `.ai/specs/2026-08-30-run-button-claim-options.md`.
 *
 * MEASURED on `prod-host`, 2026-08-30. The route called
 * `markStarted(dataDir, id, run.id)` with no options and discarded the answer. With
 * `CEZ_CLUSTER=1` set (since 2026-08-24) that is a REFUSAL — the claim goes to a hub that has
 * nobody to ask, `markStartedWithClaim` returns `hub-unconfirmed`, and it writes nothing. **0 of 13
 * Run presses stamped `startedTaskId` in five days**, against **8 of 8** autostarts in the same
 * window on the same box: the control that says the environment was never the problem, this call
 * site was.
 *
 * Two symptoms, one cause, and both are asserted here:
 *  - the filed row never leaves the board (both `todo-index.ts#isBoardVisible` and
 *    `filed-tasks.ts#isVisibleFiledEntry` hide an entry only once it carries `startedTaskId`);
 *  - the same task runs TWICE, because the route's only double-start guard is
 *    `if (todo.startedTaskId)` — keyed on the field that is never written, so it can never fire.
 *
 * **Why the existing suite is blind to it.** `todos-start.test.ts` has 24 cases and mentions
 * `startedTaskId` twice, both as INPUT: the fixtures for its two 409s. It pins the guard by handing
 * the guard its own precondition, and stays green against a route that never arms it.
 */
describe('POST /api/v1/todos/:id/start — the claim it records', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let started: string[];
  let cancelled: string[];
  let disarm: (() => void) | undefined;
  const cluster = process.env.CEZ_CLUSTER;

  const writeTodos = (todos: TodoItem[]) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify(todos, null, 2), 'utf8');
  };
  const readTodo = (id: string): TodoItem => {
    const items = JSON.parse(readFileSync(join(dataDir, 'todos.json'), 'utf8')) as TodoItem[];
    const found = items.find((t) => t.id === id);
    if (!found) throw new Error(`todo ${id} vanished from the file`);
    return found;
  };

  /** The hub's shape of the seam: it answers what kind of claim a local start makes. */
  const armHub = (localStartOptions: () => Promise<TodoStartOptions>) => {
    const dispatch: TodoAutostartDispatch = {
      localStartOptions,
      place: () => {
        throw new Error('the Run route must never place work — D15a row 1 runs it on this host');
      },
    };
    disarm = armClusterAutostart({ cluster: CLUSTERING_OFF, dispatch });
  };

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-start-claim-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    started = [];
    cancelled = [];
    const manager = {
      cancel: vi.fn((runId: string) => {
        cancelled.push(runId);
        return true;
      }),
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        const run = store.createRun({
          author: localCliAuthor(),
          title: 't',
          workflow: '(inbox)',
          task: input.task,
          steps: [],
        });
        started.push(run.id);
        return run;
      },
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    disarm?.();
    disarm = undefined;
    if (cluster === undefined) delete process.env.CEZ_CLUSTER;
    else process.env.CEZ_CLUSTER = cluster;
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const start = (id: string) =>
    apiRequest(app, `/api/v1/todos/${encodeURIComponent(id)}/start`, { method: 'POST' });

  // ---- the production configuration -----------------------------------------------------------

  it('stamps startedTaskId on a clustered hub, so the row leaves the Filed board', async () => {
    // Exactly `prod-host`: CEZ_CLUSTER=1, role hub, and the project PAIRED — so the claim is
    // clustered and the hub confirms its own, the answer `createHubAutostartDispatch` gives.
    process.env.CEZ_CLUSTER = '1';
    armHub(async () => ({
      clustered: true,
      confirmStart: async () => ({ opId: 'hub-local:t1', hubSeq: 7, accepted: true, fields: { startedOn: 'hub-1' } }),
    }));
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    const res = await start('t1');

    expect(res.status).toBe(201);
    expect(started).toHaveLength(1);
    // THE assertion the old suite never made. Without the options this is `undefined`.
    expect(readTodo('t1').startedTaskId).toBe(started[0]);
    // The acknowledgement was genuinely consulted, not merely survived — `clustered: false` would
    // also produce a stamp, and would leave both of these unset.
    expect(readTodo('t1').startedOn).toBe('hub-1');
    expect(readTodo('t1').hubSeq).toBe(7);
  });

  it('refuses the SECOND press — one todo is one run', async () => {
    // The reported bug, in the act: two `via: todo-start` runs 18s apart on one todo
    // (4d9a3166 / 3c32c52a, 2026-08-30T05:15Z). Two agents, one box, one subscription spent twice.
    process.env.CEZ_CLUSTER = '1';
    armHub(async () => ({
      clustered: true,
      confirmStart: async () => ({ opId: 'hub-local:t1', hubSeq: 7, accepted: true }),
    }));
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    expect((await start('t1')).status).toBe(201);
    const second = await start('t1');

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'already started' });
    expect(started).toHaveLength(1);
  });

  it('stamps with nothing armed and clustering ON — a spoke proceeds on human intent (D15a row 1)', async () => {
    // No policy armed, so `startOptionsForHumanStart` answers `{humanIntent: true}`. The write is
    // optimistic and SAYS so: `pendingSince` is what the outbox reconciles against.
    process.env.CEZ_CLUSTER = '1';
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    expect((await start('t1')).status).toBe(201);

    const todo = readTodo('t1');
    expect(todo.startedTaskId).toBe(started[0]);
    expect(todo.pendingSince).toBeTypeOf('string');
    expect(todo.pendingFields).toContain('startedTaskId');
  });

  it('stamps on single-node cezar exactly as it always did', async () => {
    // The regression guard for the other direction: no cluster, no policy, `humanIntent` never
    // consulted because `clusteringOn()` reads the environment as off.
    delete process.env.CEZ_CLUSTER;
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    expect((await start('t1')).status).toBe(201);
    const todo = readTodo('t1');
    expect(todo.startedTaskId).toBe(started[0]);
    expect(todo.pendingSince).toBeUndefined();
  });

  // ---- the residual: a claim that is genuinely refused ------------------------------------------

  it('a REFUSED claim still cannot become a second run, and the next press settles it', async () => {
    // Production's exact failure, reproduced deliberately: a clustered claim with a confirmer that
    // answers nothing → `hub-unconfirmed` → nothing written. The run exists and the record does not
    // know it (D43). The old route returned 201 here and let the next press start a second agent.
    process.env.CEZ_CLUSTER = '1';
    let confirms = 0;
    armHub(async () => ({
      clustered: true,
      confirmStart: async () => {
        confirms += 1;
        return confirms === 1 ? undefined : { opId: 'hub-local:t1', hubSeq: 9, accepted: true };
      },
    }));
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    // First press: the run happens, the stamp does not.
    expect((await start('t1')).status).toBe(201);
    expect(started).toHaveLength(1);
    expect(readTodo('t1').startedTaskId).toBeUndefined();

    // Second press: 409, no second run — and the orphan is settled with the run that already
    // exists, so the board recovers rather than staying doubled forever.
    const second = await start('t1');
    expect(second.status).toBe(409);
    expect(started).toHaveLength(1);
    expect(readTodo('t1').startedTaskId).toBe(started[0]);

    // Third press: the ordinary `startedTaskId` guard now answers, and still no second run.
    expect((await start('t1')).status).toBe(409);
    expect(started).toHaveLength(1);
  });

  it('NEGATIVE CONTROL — a refusal that cannot be settled still refuses, rather than starting again', async () => {
    // Without this, the case above could pass against a route that simply started a second run and
    // let the (now working) confirmer stamp THAT one: `started` would be 2 and `startedTaskId` set,
    // which reads like a recovery. Here the claim never becomes grantable, so the only correct
    // behaviour is a 409 with the run count frozen at one.
    process.env.CEZ_CLUSTER = '1';
    armHub(async () => ({ clustered: true, confirmStart: async () => undefined }));
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    expect((await start('t1')).status).toBe(201);
    expect((await start('t1')).status).toBe(409);
    expect((await start('t1')).status).toBe(409);

    expect(started).toHaveLength(1);
    expect(readTodo('t1').startedTaskId).toBeUndefined();
  });

  // ---- the race the `startedTaskId` guard cannot win --------------------------------------------

  it('a press that LOSES the claim cancels its own run rather than leaving two agents on one task', async () => {
    // Both presses read the todo before either stamps, so `if (todo.startedTaskId)` lets both
    // through — no re-read narrows that to zero. The window is real and reproduced exactly here:
    // `askHubToConfirm` runs with NO lease held (by design — it is a network round trip), and
    // `markStartedWithClaim` re-reads under the lease afterwards. A rival that lands in that gap is
    // what a second click is.
    process.env.CEZ_CLUSTER = '1';
    armHub(async () => ({
      clustered: true,
      confirmStart: async () => {
        // The rival press, landing inside the unleased window.
        writeTodos([{ id: 't1', summary: 'Ship it', startedTaskId: 'rival-run' }]);
        return { opId: 'hub-local:t1', hubSeq: 7, accepted: true };
      },
    }));
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    const res = await start('t1');

    expect(res.status).toBe(409);
    // The run WAS created — that is unavoidable, the claim needs its id — so the only correct
    // outcome is that it does not survive.
    expect(started).toHaveLength(1);
    expect(cancelled).toEqual(started);
    // The winner's stamp is untouched: the loser must never overwrite it with its own run.
    expect(readTodo('t1').startedTaskId).toBe('rival-run');
  });

  it('NEGATIVE CONTROL — an UNCONFIRMED claim leaves its run alive; only a named winner cancels one', async () => {
    // Without this, "cancel on refusal" would look right while quietly throwing away every run
    // started during a hub outage — the D15a row-1 case, where the person's work is real and the
    // only thing missing is an acknowledgement.
    process.env.CEZ_CLUSTER = '1';
    armHub(async () => ({ clustered: true, confirmStart: async () => undefined }));
    writeTodos([{ id: 't1', summary: 'Ship it' }]);

    expect((await start('t1')).status).toBe(201);

    expect(started).toHaveLength(1);
    expect(cancelled).toEqual([]);
  });
});
