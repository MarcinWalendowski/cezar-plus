import { closeSync, lstatSync, mkdtempSync, openSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterOp } from '@loki-labs/better-cezar-contract';
import { readTodos, removeTodo, type TodoItem } from '../todos.ts';
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

      // The verdict alone is not enough: this test passed unchanged with the file write suppressed
      // entirely, because it only ever read the returned object. The claim has to still BE on the
      // record afterwards, and the resent op's own hubSeq has to have landed with it.
      const items = await readTodos(dataDir);
      const item = items.find((t) => t.id === 't1');
      expect(item?.startedTaskId).toBe('task-1');
      expect(item?.startedOn).toBe('node-winner');
      expect(item?.hubSeq).toBe(5);
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

  // ---- 7. the lease is the SAME lock every todos.ts writer takes -------------------------------

  it('the write lease is the SAME lock file todos.ts own writers take (not a second, parallel lock)', async () => {
    // This module restates `todos.ts#acquireTodosLease`'s `O_EXCL` idiom rather than importing it
    // (that file exports no lease helper). A restatement that keyed on a DIFFERENT path would look
    // identical, pass every other test here, and let the hub read-modify-write `todos.json`
    // concurrently with the five writers inside `todos.ts` — a lost write, not a style nit. So the
    // identity of the PATH is what is asserted, from the other side: a lock this module's own
    // `todos.lock` name resolves to must block a `todos.ts` writer.
    await seed([{ id: 't1', summary: 'Ship it' }]);
    const lockPath = join(dataDir, 'todos.lock');
    closeSync(openSync(lockPath, 'wx', 0o600));

    let removed = false;
    let applied = false;
    // `removeTodo` is one of the five writers that go through `todos.ts#withTodosLease`; it takes
    // the lease before it decides anything, so a missing id still contends for it.
    const blockedStoreWriter = removeTodo(dataDir, 'no-such-id').then((v) => {
      removed = true;
      return v;
    });
    const blockedHubApply = applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, fields: { status: 'done' } }), {
      lockTimeoutMs: 5_000,
    }).then((v) => {
      applied = true;
      return v;
    });

    await new Promise((r) => setTimeout(r, 300));
    // BOTH assertions, in one test, on ONE lock file — asserting only the `todos.ts` side would
    // hold true no matter what this module named its own lock, which is the half of the proof that
    // matters. Verified by mutation: renaming `TODOS_LOCK_FILE` here leaves `applied` true at this
    // line.
    expect(removed).toBe(false);
    expect(applied).toBe(false);

    unlinkSync(lockPath);
    await blockedStoreWriter;
    expect(await blockedHubApply).toEqual({ accepted: true });
    expect(removed).toBe(true);
  });

  it('the record is read FRESH inside the lease — a write that lands while this op waits is not clobbered', async () => {
    // The lost-write shape `todos.ts#readTodos` carries its own correction about ("a todo vanished
    // from production's todos.json that way on 2026-08-22"): read the array, wait for the lease,
    // then write back the stale snapshot over whoever got there first.
    await seed([{ id: 't1', summary: 'A' }]);
    const lockPath = join(dataDir, 'todos.lock');
    closeSync(openSync(lockPath, 'wx', 0o600));

    const applying = applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 7, fields: { status: 'done' } }), { lockTimeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 150));

    // Another writer got in first and added t2 while this op was queued behind the lease.
    await fs.writeFile(
      join(dataDir, 'todos.json'),
      JSON.stringify([{ id: 't1', summary: 'A' }, { id: 't2', summary: 'B' }], null, 2),
      'utf8',
    );
    unlinkSync(lockPath);

    expect(await applying).toEqual({ accepted: true });
    const items = await readTodos(dataDir);
    expect(items.map((t) => t.id).sort()).toEqual(['t1', 't2']); // t2 survived
    expect(items.find((t) => t.id === 't1')?.status).toBe('done');
  });

  // ---- 8. the file round-trips faithfully (D13, and unhealed rows) -----------------------------

  it('D13: a field this build has never heard of survives the rewrite, on the touched row AND an untouched one', async () => {
    // Every apply rewrites the WHOLE file, so a key this reader drops is gone from every other
    // node's history too. `storedTodoSchema` is `.passthrough()` precisely so it cannot be.
    await seed([
      { id: 't1', summary: 'Ship it', fromANewerNode: { nested: 'keep me' } },
      { id: 't2', summary: 'Untouched', alsoUnknown: [1, 2, 3] },
    ]);

    await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, fields: { status: 'done' } }));

    // Read the raw bytes, not `readTodos` — that parses with the same passthrough schema and would
    // agree with a drop that had already happened on disk.
    const raw = JSON.parse(await fs.readFile(join(dataDir, 'todos.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(raw.find((r) => r.id === 't1')?.fromANewerNode).toEqual({ nested: 'keep me' });
    expect(raw.find((r) => r.id === 't2')?.alsoUnknown).toEqual([1, 2, 3]);
  });

  it('an id-less row (an unhealed raw agent append) is carried through the rewrite, never dropped', async () => {
    // `readTodos` heals these under the lease; this module deliberately does not (D5a — an op's
    // entityId always names an already-healed id). Not healing is fine; DROPPING is data loss.
    await seed([{ summary: 'raw agent append, no id' }, { id: 't1', summary: 'Ship it' }]);

    await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, fields: { status: 'done' } }));

    const raw = JSON.parse(await fs.readFile(join(dataDir, 'todos.json'), 'utf8')) as Array<Record<string, unknown>>;
    expect(raw).toHaveLength(2);
    expect(raw.find((r) => r.summary === 'raw agent append, no id')).toBeDefined();
    expect(raw.find((r) => r.id === 't1')?.status).toBe('done');
  });

  // ---- 9. a claim is never answered by the hubSeq replay guard ---------------------------------

  it('a claim on an UNCLAIMED todo whose hubSeq is already ABOVE the op is APPLIED, not silently accepted', async () => {
    // The ordering hazard the module docblock names, in its second form. The first form (a LOSING
    // claim carrying a lower hubSeq) is covered above. This is the one where nobody has claimed the
    // todo yet, but an ordinary field op from another node reached the lease first and carried the
    // record's hubSeq past this claim's own. The replay guard would then answer `{ accepted: true }`
    // for a claim it never wrote — and `accepted` is the spoke's permission to START, so the hub
    // would be granting a run it has no record of, which is the double-start D9a exists to prevent.
    await seed([{ id: 't1', summary: 'Ship it' }]);
    await applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 60, fields: { status: 'in-progress' } }));

    const claim = await applyOpAtHub(
      dataDir,
      makeOp({ entityId: 't1', hubSeq: 10, nodeId: 'node-a', fields: { startedTaskId: 'task-1' } }),
    );

    expect(claim.accepted).toBe(true);
    expect(claim.fields).toEqual({ startedTaskId: 'task-1', startedOn: 'node-a' });

    const items = await readTodos(dataDir);
    const item = items.find((t) => t.id === 't1');
    expect(item?.startedTaskId).toBe('task-1');
    expect(item?.startedOn).toBe('node-a');
    // The older op must not drag the record's hub order backwards on its way in.
    expect(item?.hubSeq).toBe(60);

    // The assertion that makes this about a double START rather than a missing field: because the
    // claim really landed, the NEXT node to ask is refused. If the claim had been answered by the
    // replay guard, this second one would be accepted too and two nodes would both be running it.
    const second = await applyOpAtHub(
      dataDir,
      makeOp({ entityId: 't1', hubSeq: 70, nodeId: 'node-b', fields: { startedTaskId: 'task-2' } }),
    );
    expect(second.accepted).toBe(false);
    expect(second.fields).toEqual({ startedTaskId: 'task-1', startedOn: 'node-a' });
  });

  it('an empty-string startedTaskId is not a claim holder — it must not wedge the todo against every future claim', async () => {
    // `todos.ts#markStartedWithClaim` tests `if (item.startedTaskId)` — truthiness — so it reads ''
    // as UNCLAIMED and goes on to ask the hub. One concept enforced at two points: if this side
    // reads '' as a holder instead, every claim on that row is refused forever, naming a winner of
    // ''. `todoSchema`'s `startedTaskId` is `z.string().optional()` with no `min(1)`, so '' stores.
    await seed([{ id: 't1', summary: 'Ship it', startedTaskId: '' }]);

    const claim = await applyOpAtHub(
      dataDir,
      makeOp({ entityId: 't1', hubSeq: 1, nodeId: 'node-a', fields: { startedTaskId: 'task-1' } }),
    );

    expect(claim.accepted).toBe(true);
    expect((await readTodos(dataDir)).find((t) => t.id === 't1')?.startedTaskId).toBe('task-1');
  });

  // ---- 10. an unreadable store is transient, and must never be replaced ------------------------

  it('a todos.json that cannot be READ throws, and the store is left untouched (never replaced by one row)', async () => {
    // A read that fails for any reason other than "no file yet" is a transient failure, and this
    // module's whole reject-vs-throw contract turns on that distinction. Treating it as an empty
    // inbox is what makes it destructive rather than merely wrong: the apply would then write a
    // ONE-ROW file over a store it could not read. Reproduced with a self-referential symlink
    // (ELOOP) because it needs no particular uid — the production shape is a root-owned
    // `todos.json` in a cezar-owned directory, where the read fails but the rename still succeeds.
    await fs.mkdir(dataDir, { recursive: true });
    symlinkSync('todos.json', join(dataDir, 'todos.json'));

    await expect(applyOpAtHub(dataDir, makeOp({ entityId: 't1', hubSeq: 1, fields: { status: 'done' } }))).rejects.toThrow(
      /could not be read/i,
    );

    // Nothing was written over it — still the symlink, not a regular file holding one row.
    expect(lstatSync(join(dataDir, 'todos.json')).isSymbolicLink()).toBe(true);
  });

  it('createHubApplyOp closes over dataDir and behaves identically to applyOpAtHub', async () => {
    await seed([{ id: 't1', summary: 'Ship it' }]);
    const applyOp = createHubApplyOp(dataDir);
    const outcome = await applyOp(makeOp({ entityId: 't1', hubSeq: 1, fields: { status: 'done' } }));
    expect(outcome).toEqual({ accepted: true });
    expect((await readTodos(dataDir)).find((t) => t.id === 't1')?.status).toBe('done');
  });
});
