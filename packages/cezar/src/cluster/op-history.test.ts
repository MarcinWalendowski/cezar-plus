import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterAckResult } from '@loki-labs/cezar-plus-contract';
import type { ClusterHomeOptions } from './node-identity.ts';
import { clusterHomeDir } from './node-identity.ts';
import { createOpHistoryStore, opHistoryPath, OP_HISTORY_RETENTION_MS } from './op-history.ts';

/**
 * The hub's durable per-`opId` verdict cache (`cluster/hub-ops.ts#HubOpsDeps`'s `findAppliedOp` /
 * `recordAppliedOp`; spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, Milestone B, D4/D9a).
 * `CEZ_HOME` is never mutated on `process.env` — every call passes `options.env` explicitly,
 * matching `hub-seq.test.ts`'s own reasoning: it is what lets the burst test below fire many
 * truly-concurrent calls without one test's global env pin racing another's.
 */
describe('cluster/op-history', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-op-history-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function options(overrides: Partial<ClusterHomeOptions> = {}): ClusterHomeOptions {
    return { env: { ...process.env, CEZ_HOME: home }, ...overrides };
  }

  function verdict(overrides: Partial<ClusterAckResult> = {}): ClusterAckResult {
    return { opId: 'op-1', hubSeq: 1, accepted: true, ...overrides };
  }

  it('opHistoryPath lives under <CEZ_HOME>/cluster/op-history.json', () => {
    expect(opHistoryPath(options().env)).toBe(join(clusterHomeDir(options().env), 'op-history.json'));
  });

  describe('round trip — basic contract', () => {
    it('find() on an unknown opId is undefined, not a throw, and touches no file', async () => {
      const store = createOpHistoryStore(options());
      expect(await store.find('never-seen')).toBeUndefined();
      expect(existsSync(opHistoryPath(options().env))).toBe(false);
    });

    it('record() then find() round-trips the exact verdict, including fields/reason', async () => {
      const store = createOpHistoryStore(options());
      const v = verdict({ opId: 'op-1', hubSeq: 7, accepted: false, reason: 'already claimed', fields: { startedOn: 'node-b' } });
      await store.record('op-1', v);
      expect(await store.find('op-1')).toEqual(v);
    });

    it('a second, unrelated opId stays undefined after a different opId is recorded', async () => {
      const store = createOpHistoryStore(options());
      await store.record('op-1', verdict({ opId: 'op-1' }));
      expect(await store.find('op-2')).toBeUndefined();
    });

    it('record() rejects a result whose opId does not match the key it is stored under', async () => {
      const store = createOpHistoryStore(options());
      await expect(store.record('op-1', verdict({ opId: 'op-2' }))).rejects.toThrow(/opId/);
    });
  });

  describe('survives a simulated restart', () => {
    it('a fresh store built on the same home still finds a verdict recorded by an earlier one', async () => {
      const first = createOpHistoryStore(options());
      await first.record('op-1', verdict({ opId: 'op-1', hubSeq: 3, accepted: true }));

      // Throw the store away and build a brand new one — nothing but the on-disk file connects
      // them, simulating the hub's blue-green restart (spec: ~10x/day).
      const second = createOpHistoryStore(options());
      expect(await second.find('op-1')).toEqual(verdict({ opId: 'op-1', hubSeq: 3, accepted: true }));
    });
  });

  describe('concurrency — N concurrent record() calls for distinct opIds all land (spec brief requirement 3)', () => {
    // Verification (spec brief): a torn read-modify-write without the lock loses updates FAR more
    // often than it crashes outright — a pairwise check would pass against a broken allocator, so
    // this fires a real burst and checks the UNION survives completely.
    it('BURST concurrent record() calls all survive — none lost to a torn read-modify-write', async () => {
      const store = createOpHistoryStore(options());
      const opIds = Array.from({ length: 24 }, (_, i) => `op-${i}`);

      await Promise.all(opIds.map((opId, i) => store.record(opId, verdict({ opId, hubSeq: i + 1, accepted: i % 2 === 0 }))));

      for (const [i, opId] of opIds.entries()) {
        expect(await store.find(opId)).toEqual(verdict({ opId, hubSeq: i + 1, accepted: i % 2 === 0 }));
      }

      // Cross-check directly against the file too — a lost write could in principle still pass the
      // find()-only loop above if find() itself masked something (it does not, but this is the
      // ground truth check).
      const onDisk = JSON.parse(readFileSync(opHistoryPath(options().env), 'utf8')) as { entries: Record<string, unknown> };
      expect(Object.keys(onDisk.entries)).toHaveLength(24);
    });
  });

  describe('corruption — fail closed on find(), never reuse a resolved opId as fresh (requirement 1)', () => {
    it('sanity/negative control: an intact store legitimately answers undefined for a fresh opId (not a throw)', async () => {
      const store = createOpHistoryStore(options());
      // No corruption anywhere — proves the throws below are about corruption specifically, not
      // about "any opId this store has never seen".
      expect(await store.find('genuinely-fresh')).toBeUndefined();
    });

    it('a whole-file-corrupt store refuses EVERY lookup, including opIds untouched by the corruption', async () => {
      const store = createOpHistoryStore(options());
      await store.record('op-1', verdict({ opId: 'op-1' }));
      mkdirSync(clusterHomeDir(options().env), { recursive: true });
      writeFileSync(opHistoryPath(options().env), 'not json {{{', 'utf8');

      const warnings: string[] = [];
      const warned = createOpHistoryStore(options({ warn: (m) => warnings.push(m) }));
      await expect(warned.find('op-1')).rejects.toThrow(/corrupt/);
      await expect(warned.find('never-touched')).rejects.toThrow(/corrupt/);
      await expect(warned.record('op-2', verdict({ opId: 'op-2' }))).rejects.toThrow(/corrupt/);
      await expect(warned.prune()).rejects.toThrow(/corrupt/);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('a poisoned single entry refuses only that opId — a different, healthy opId keeps working', async () => {
      const store = createOpHistoryStore(options());
      await store.record('op-1', verdict({ opId: 'op-1', hubSeq: 1 }));
      await store.record('op-2', verdict({ opId: 'op-2', hubSeq: 2 }));

      const path = opHistoryPath(options().env);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown> };
      onDisk.entries['op-1'] = { at: 'not-a-real-date', result: { opId: 'op-1' } }; // fails the schema
      writeFileSync(path, JSON.stringify(onDisk), 'utf8');

      const warnings: string[] = [];
      const warned = createOpHistoryStore(options({ warn: (m) => warnings.push(m) }));
      // The critical assertion: this must NOT silently answer undefined, which would let
      // applyOpsFrame treat an already-resolved op as fresh and re-apply it.
      await expect(warned.find('op-1')).rejects.toThrow(/unreadable/);
      expect(await warned.find('op-2')).toEqual(verdict({ opId: 'op-2', hubSeq: 2 }));
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('recording a fresh verdict for a previously-poisoned opId heals it — record() does not inherit find()\'s refusal', async () => {
      const path = opHistoryPath(options().env);
      mkdirSync(clusterHomeDir(options().env), { recursive: true });
      writeFileSync(path, JSON.stringify({ entries: { 'op-1': { at: 'garbage', result: {} } } }), 'utf8');

      const store = createOpHistoryStore(options());
      await expect(store.find('op-1')).rejects.toThrow(/unreadable/); // still poisoned before the write

      await store.record('op-1', verdict({ opId: 'op-1', hubSeq: 9 }));
      expect(await store.find('op-1')).toEqual(verdict({ opId: 'op-1', hubSeq: 9 }));
    });

    it('a write for a healthy opId preserves a sibling poisoned entry VERBATIM rather than healing it to absent', async () => {
      const path = opHistoryPath(options().env);
      mkdirSync(clusterHomeDir(options().env), { recursive: true });
      writeFileSync(path, JSON.stringify({ entries: { 'op-1': { at: 'garbage', result: {} } } }), 'utf8');

      const store = createOpHistoryStore(options());
      await store.record('op-2', verdict({ opId: 'op-2', hubSeq: 5 }));

      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown> };
      // Dropping it would silently heal it back to "absent," which reads as undefined on the next
      // read and reopens the reuse hole this file exists to close.
      expect(onDisk.entries['op-1']).toEqual({ at: 'garbage', result: {} });
    });
  });

  describe('retention — an entry past the window is pruned, one inside it is kept (requirement 2)', () => {
    it('boundary asserted explicitly: exactly at the window edge is kept, one ms older is pruned', async () => {
      const pruneAt = new Date('2026-09-01T00:00:00.000Z');
      const cutoff = pruneAt.getTime() - OP_HISTORY_RETENTION_MS;

      let clock = new Date(cutoff); // age === RETENTION_MS exactly at prune time
      const store = createOpHistoryStore(options({ now: () => clock }));
      await store.record('at-boundary', verdict({ opId: 'at-boundary' }));

      clock = new Date(cutoff - 1); // one ms OLDER than the window
      await store.record('past-boundary', verdict({ opId: 'past-boundary' }));

      clock = new Date(cutoff + 60_000); // comfortably inside the window
      await store.record('fresh', verdict({ opId: 'fresh' }));

      const removed = await store.prune(pruneAt);

      expect(removed).toBe(1);
      expect(await store.find('at-boundary')).toBeDefined();
      expect(await store.find('past-boundary')).toBeUndefined();
      expect(await store.find('fresh')).toBeDefined();
    });

    it('prune() defaults to the real/injected clock when called with no argument', async () => {
      let clock = new Date('2026-01-01T00:00:00.000Z');
      const store = createOpHistoryStore(options({ now: () => clock }));
      await store.record('old', verdict({ opId: 'old' }));

      clock = new Date(clock.getTime() + OP_HISTORY_RETENTION_MS + 1_000);
      const removed = await store.prune(); // no explicit `now` — uses options.now
      expect(removed).toBe(1);
      expect(await store.find('old')).toBeUndefined();
    });

    it('prune() leaves a poisoned entry untouched, and still prunes healthy expired entries around it', async () => {
      const path = opHistoryPath(options().env);
      let clock = new Date('2026-01-01T00:00:00.000Z');
      const store = createOpHistoryStore(options({ now: () => clock }));
      await store.record('old', verdict({ opId: 'old' }));

      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown> };
      onDisk.entries['poisoned'] = { at: 'garbage', result: {} };
      writeFileSync(path, JSON.stringify(onDisk), 'utf8');

      clock = new Date(clock.getTime() + OP_HISTORY_RETENTION_MS + 1_000);
      const removed = await store.prune();
      expect(removed).toBe(1); // only "old" — "poisoned" is neither counted nor thrown on

      const after = JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown> };
      expect(after.entries['poisoned']).toEqual({ at: 'garbage', result: {} });
    });

    it('an empty/never-written store prunes to 0, and writes no op-history.json', async () => {
      const store = createOpHistoryStore(options());
      expect(await store.prune(new Date())).toBe(0);
      expect(existsSync(opHistoryPath(options().env))).toBe(false);
    });
  });
});
