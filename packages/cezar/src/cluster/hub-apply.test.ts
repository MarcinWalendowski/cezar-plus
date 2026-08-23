import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterOp } from '@loki-labs/better-cezar-contract';
import { readTodos, type TodoItem } from '../todos.ts';
import { applyOpAtHub, createHubApplyOp, type HubApplyOptions } from './hub-apply.ts';

/**
 * `cluster/hub-apply.ts` — the hub's real implementation of
 * `cluster/hub-ops.ts#HubOpsDeps['applyOp']` (spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`,
 * "What remains" → Milestone B; D4 · D6 · D7 · D9a). See that file's own module docblock for the
 * reasoning; these are the verifications its own docblock and the implementation brief both name.
 */

let opSeq = 0;
function makeOp(overrides: Partial<ClusterOp> & { entityId: string; hubSeq: number }): ClusterOp & { hubSeq: number } {
  opSeq += 1;
  return {
    opId: `op-${opSeq}`,
    nodeId: 'node-a',
    ts: '2026-08-23T00:00:00.000Z',
    scope: 'project',
    entity: 'todo',
    op: 'upsert',
    ...overrides,
    hubSeq: overrides.hubSeq,
  };
}

describe('cluster/hub-apply applyOpAtHub', () => {
  let root: string;
  let dataDir: string;
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-hub-apply-'));
    dataDir = join(root, '.ai/cezar');
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) fn();
    rmSync(root, { recursive: true, force: true });
  });

  const seed = async (todos: object[]) => {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(join(dataDir, 'todos.json'), JSON.stringify(todos, null, 2), 'utf8');
  };

  // ---- 1. an upsert applies through the store API ------------------------------------------------

  it('an upsert applies, and the row is readable through readTodos afterwards (the store API, not a bare file write)', async () => {
    await seed([{ id: 't1', summary: 'Ship it', status: 'todo' }]);

    const outcome = await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 10, fields: { status: 'done' } }));

    expect(outcome).toEqual({ accepted: true });
    const items = await readTodos(dataDir);
    const item = items.find((t) => t.id === 't1');
    expect(item?.status).toBe('done');
    expect(item?.hubSeq).toBe(10);
    // Optimistic-write bookkeeping is settled by a hub-applied change, same as `applyOpToRecord`
    // documents for the spoke side — nothing is left "pending" once the hub has spoken for it.
    expect(item?.pendingSince).toBeUndefined();
  });

  it('an upsert for an entity the hub has never seen creates the row (D6/D8: unseen entity gets a placeholder, not a refusal)', async () => {
    await seed([]);
    const outcome = await applyOpAtHub(dataDir, makeOp({ entityId: 'brand-new', hubSeq: 1, fields: { summary: 'from a spoke' } }));
    expect(outcome).toEqual({ accepted: true });
    const items = await readTodos(dataDir);
    expect(items.find((t) => t.id === 'brand-new')?.summary).toBe('from a spoke');
  });

  // ---- 2. D9a — claim won / claim lost, asserting the FIELD VALUES ------------------------------

  describe('D9a claim resolution', () => {
    it('a claim on an unclaimed todo is accepted, and startedOn is the CLAIMING node id (not a timestamp)', async () => {
      await seed([{ id: 't1', summary: 'Ship it' }]);

      const outcome = await applyOpAtHub(
        dataDir,
        makeOp({ entityId: 't1', hubSeq: 1, nodeId: 'node-winner', fields: { startedTaskId: 'task-1' } }),
      );

      expect(outcome.accepted).toBe(true);
      expect(outcome.fields).toEqual({ startedTaskId: 'task-1', startedOn: 'node-winner' });
      const items = await readTodos(dataDir);
      const item = items.find((t) => t.id === 't1');
      expect(item?.startedTaskId).toBe('task-1');
      expect(item?.startedOn).toBe('node-winner');
    });

    it('a second, DIFFERENT claim on an already-started todo is rejected with the WINNER applied values', async () => {
      await seed([{ id: 't1', summary: 'Ship it' }]);

      const first = await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, nodeId: 'node-winner', fields: { startedTaskId: 'task-1' } }));
      expect(first.accepted).toBe(true);

      const second = await applyOpAtHub(
        dataDir,
        makeOp({ entityId: 't1', hubSeq: 2, nodeId: 'node-loser', fields: { startedTaskId: 'task-2' } }),
      );

      // The flag alone is not enough (a stub returning no `fields` would pass a flag-only assert):
      // D9a is implementable only if the LOSER learns the winner's own claim state.
      expect(second.accepted).toBe(false);
      expect(second.reason).toBe('already-started');
      expect(second.fields).toEqual({ startedTaskId: 'task-1', startedOn: 'node-winner' });

      // And nothing was written for the losing op: the record still names the winner, verbatim.
      const items = await readTodos(dataDir);
      const item = items.find((t) => t.id === 't1');
      expect(item?.startedTaskId).toBe('task-1');
      expect(item?.startedOn).toBe('node-winner');
      expect(item?.hubSeq).toBe(1); // the loser's hubSeq (2) never touched the record
    });

    it('a resend of the SAME winning claim (new opId, same startedTaskId) is accepted, not rejected against itself', async () => {
      await seed([{ id: 't1', summary: 'Ship it' }]);
      await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, nodeId: 'node-winner', fields: { startedTaskId: 'task-1' } }));

      const resend = await applyOpAtHub(
        dataDir,
        makeOp({ entityId: 't1', hubSeq: 5, nodeId: 'node-winner', fields: { startedTaskId: 'task-1' } }),
      );

      expect(resend.accepted).toBe(true);
      expect(resend.fields).toEqual({ startedTaskId: 'task-1', startedOn: 'node-winner' });
    });

    it('a losing claim beats a WINNER that has a HIGHER hubSeq — the conflict check must not depend on hubSeq ordering', async () => {
      // The loser's op can carry a LOWER hubSeq than the winner's if the loser's frame simply
      // reaches this lease first (see module docblock) — reproduced directly here rather than via
      // timing, so the test is deterministic: apply the "winner" at hubSeq 50 first, so the record
      // already shows a higher hubSeq than the later-processed "loser" op which is deliberately
      // stamped with a LOWER hubSeq (10).
      await seed([{ id: 't1', summary: 'Ship it' }]);
      await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 50, nodeId: 'node-winner', fields: { startedTaskId: 'task-1' } }));

      const loser = await applyOpAtHub(
        dataDir,
        makeOp({ entityId: 't1', hubSeq: 10, nodeId: 'node-loser', fields: { startedTaskId: 'task-2' } }),
      );

      // If the staleness guard ran BEFORE the claim check (or in its place), this would wrongly
      // read `hubSeq 10 <= 50` and answer `{ accepted: true }` — permission for node-loser to
      // start a second run. This is exactly the case the module docblock's ordering note exists
      // for.
      expect(loser.accepted).toBe(false);
      expect(loser.fields).toEqual({ startedTaskId: 'task-1', startedOn: 'node-winner' });
    });
  });

  // ---- 3. transient failure THROWS, never a synthetic accepted:false ----------------------------

  it('a stuck write lease THROWS — it must never be reported as accepted:false', async () => {
    await seed([{ id: 't1', summary: 'Ship it' }]);
    const lockPath = join(dataDir, 'todos.lock');
    const fd = openSync(lockPath, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
    cleanups.push(() => {
      try {
        closeSync(fd);
      } catch {
        // already closed by the test body below
      }
    });

    const options: HubApplyOptions = { lockTimeoutMs: 120, staleAfterMs: 10 * 60_000 };
    await expect(applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, fields: { status: 'done' } }), options)).rejects.toThrow(
      /write lease.*stayed held/i,
    );

    closeSync(fd);
  });

  // ---- 4. replay of the same (or a lower) hubSeq is a no-op, not a re-apply ---------------------

  it('replaying an op at or below the record’s own hubSeq is a no-op', async () => {
    await seed([{ id: 't1', summary: 'Ship it', priority: 'low' }]);
    await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 10, fields: { priority: 'high' } }));

    // A later op (hubSeq 20) supersedes it first.
    await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 20, fields: { priority: 'low' } }));

    // Now the ORIGINAL op (hubSeq 10) arrives again (a resent/duplicate frame) — it must not
    // regress the record back to 'high'.
    const replay = await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 10, fields: { priority: 'high' } }));
    expect(replay).toEqual({ accepted: true });

    const items = await readTodos(dataDir);
    expect(items.find((t) => t.id === 't1')?.priority).toBe('low');
    expect(items.find((t) => t.id === 't1')?.hubSeq).toBe(20);
  });

  // ---- 5. a tombstone is a value, never a removal (D6) -------------------------------------------

  it('a tombstone op marks the row, and never removes it from the file', async () => {
    await seed([{ id: 't1', summary: 'Ship it' }, { id: 't2', summary: 'Keep this one' }]);

    const outcome = await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, op: 'tombstone' }));
    expect(outcome).toEqual({ accepted: true });

    const items = await readTodos(dataDir);
    expect(items).toHaveLength(2);
    const tombstoned = items.find((t) => t.id === 't1');
    expect(tombstoned?.tombstone).toBeDefined();
    expect(items.find((t) => t.id === 't2')?.summary).toBe('Keep this one');
  });

  // ---- 6. negative control: an unsupported entity kind must refuse, not fabricate a verdict -----

  it('negative control: a non-todo entity throws rather than returning any verdict', async () => {
    await seed([]);
    await expect(
      applyOpAtHub(dataDir, { ...makeOp({ entityId: 'run-1', hubSeq: 1, fields: { status: 'done' } }), entity: 'run' }),
    ).rejects.toThrow(/no store for entity "run"/);
  });

  // ---- createHubApplyOp — the HubOpsDeps['applyOp'] closure factory ------------------------------

  it('createHubApplyOp closes over dataDir and behaves identically to applyOpAtHub', async () => {
    await seed([{ id: 't1', summary: 'Ship it' }]);
    const applyOp = createHubApplyOp(dataDir);
    const outcome = await applyOp(makeOp({ entityId: 't1', hubSeq: 1, fields: { status: 'done' } }));
    expect(outcome).toEqual({ accepted: true });
    expect((await readTodos(dataDir)).find((t) => t.id === 't1')?.status).toBe('done');
  });
});
