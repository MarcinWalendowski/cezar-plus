import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClusterOp } from '@loki-labs/better-cezar-contract';
import { appendOps, compactOpLog, opLogPath, readOps, truncateOpLog } from './oplog.ts';
import { deriveTodoOps, newOpId } from './ops.ts';
import type { TodoItem } from '../todos.ts';

/**
 * Package 2.1 (`.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`), covering spec Verification
 * **5b** end to end: the outbox is re-derivable after `ops.ndjson` is lost outright. `ops.ts`'s own
 * pure-function tests live in `ops.test.ts`; this file is the filesystem half.
 */

function makeOp(entityId: string, overrides: Partial<ClusterOp> = {}): ClusterOp {
  return {
    opId: newOpId(),
    nodeId: 'node-a',
    ts: '2026-08-22T00:00:00.000Z',
    scope: 'project',
    projectKey: 'proj-1',
    entity: 'todo',
    entityId,
    op: 'upsert',
    fields: { summary: 'x' },
    ...overrides,
  };
}

describe('cluster/oplog', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cez-oplog-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('opLogPath is beside the project data dir, under cluster/ops.ndjson', () => {
    expect(opLogPath(dataDir)).toBe(join(dataDir, 'cluster', 'ops.ndjson'));
  });

  it('a missing log reads as empty, not an error — a node that has never flushed is not an error state', async () => {
    const result = await readOps(dataDir);
    expect(result).toEqual({ ops: [], dropped: 0 });
  });

  it('appendOps + readOps round-trip', async () => {
    const ops = [makeOp('t1'), makeOp('t2'), makeOp('t3')];
    await appendOps(dataDir, ops);
    const { ops: read, dropped } = await readOps(dataDir);
    expect(dropped).toBe(0);
    expect(read.map((o) => o.entityId).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('appending in two batches accumulates rather than overwriting', async () => {
    await appendOps(dataDir, [makeOp('t1')]);
    await appendOps(dataDir, [makeOp('t2')]);
    const { ops } = await readOps(dataDir);
    expect(ops.map((o) => o.entityId).sort()).toEqual(['t1', 't2']);
  });

  it('appendOps with an empty array is a no-op (does not even create the file)', async () => {
    await appendOps(dataDir, []);
    const { ops } = await readOps(dataDir);
    expect(ops).toEqual([]);
  });

  it('negative control 1 (file level) — one corrupt NDJSON line among nine good ones yields nine ops, not zero', async () => {
    const good = Array.from({ length: 9 }, (_, i) => makeOp(`t${i}`));
    await appendOps(dataDir, good);
    // Splice one corrupt line into the middle of the file directly.
    const path = opLogPath(dataDir);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    lines.splice(4, 0, '{not valid json');
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');

    const { ops, dropped } = await readOps(dataDir);
    expect(ops).toHaveLength(9);
    expect(dropped).toBe(1);
  });

  it('a write failure is warned and swallowed, never thrown (dataDir is unwritable)', async () => {
    const blocked = join(dataDir, 'not-a-directory');
    writeFileSync(blocked, 'i am a file');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(appendOps(blocked, [makeOp('t1')])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('compactOpLog rewrites the log through compactOps and reports kept/removed', async () => {
    await appendOps(dataDir, [
      makeOp('t1', { fields: { summary: 'first' }, ts: '2026-08-22T00:00:00.000Z' }),
      makeOp('t1', { fields: { summary: 'second' }, ts: '2026-08-22T00:00:01.000Z' }),
      makeOp('t2', { hubSeq: 1, ts: '2026-08-22T00:00:00.000Z' }),
    ]);
    const result = await compactOpLog(dataDir, { ackedThroughHubSeq: 1, tombstoneRetentionMs: 60_000 });
    expect(result).toEqual({ kept: 1, removed: 2 });

    const { ops } = await readOps(dataDir);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.entityId).toBe('t1');
    expect(ops[0]?.fields).toEqual({ summary: 'second' });
  });

  it('compactOpLog leaves no dangling .tmp file behind', async () => {
    await appendOps(dataDir, [makeOp('t1')]);
    await compactOpLog(dataDir, { ackedThroughHubSeq: 0, tombstoneRetentionMs: 60_000 });
    expect(() => readFileSync(`${opLogPath(dataDir)}.tmp`)).toThrow();
  });

  it('truncateOpLog empties the log — used after a full re-derive, when the log is known redundant', async () => {
    await appendOps(dataDir, [makeOp('t1'), makeOp('t2')]);
    await truncateOpLog(dataDir);
    const { ops } = await readOps(dataDir);
    expect(ops).toEqual([]);
  });

  describe('test 5b — the outbox is re-derivable', () => {
    function pendingTodo(id: string, pendingSince: string, extra: Partial<TodoItem> = {}): TodoItem {
      return { id, summary: `todo ${id}`, pendingSince, ...extra } as TodoItem;
    }

    it('deleting ops.ndjson entirely and re-scanning brings back the same unsent ops from the records marked pendingSince', async () => {
      const todos = [
        pendingTodo('t1', '2026-08-22T10:00:00.000Z', { status: 'todo' }),
        pendingTodo('t2', '2026-08-22T10:00:01.000Z', { priority: 'high' }),
        { id: 't3', summary: 'not pending' } as TodoItem, // no pendingSince — must not appear either time
      ];
      const deriveInput = { nodeId: 'node-a', projectKey: 'proj-1', todos, ackedThroughHubSeq: 0 };

      const firstDerive = deriveTodoOps(deriveInput);
      await appendOps(dataDir, firstDerive);
      const beforeDelete = await readOps(dataDir);
      expect(beforeDelete.ops.map((o) => o.entityId).sort()).toEqual(['t1', 't2']);

      // The crash: the log is gone outright.
      rmSync(opLogPath(dataDir), { force: true });
      const afterDelete = await readOps(dataDir);
      expect(afterDelete).toEqual({ ops: [], dropped: 0 });

      // The re-scan: re-derive from the SAME record state (this is what a boot-time scan does —
      // the records themselves, not the log, are the source of truth) and re-append.
      const secondDerive = deriveTodoOps(deriveInput);
      await appendOps(dataDir, secondDerive);
      const afterRederive = await readOps(dataDir);

      // Same set of entities, same op kind, same content — opId is a fresh envelope id each call
      // (see ops.test.ts) and is not part of "the same ops" for this purpose.
      const strip = (ops: ClusterOp[]) =>
        ops
          .map(({ opId: _opId, ...rest }) => rest)
          .sort((a, b) => a.entityId.localeCompare(b.entityId));
      expect(strip(afterRederive.ops)).toEqual(strip(beforeDelete.ops));
      expect(afterRederive.ops.map((o) => o.entityId).sort()).toEqual(['t1', 't2']);
    });
  });
});
