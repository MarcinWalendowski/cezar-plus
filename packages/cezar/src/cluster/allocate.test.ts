import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, type ClusterNodeId } from '@loki-labs/better-cezar-contract';
import { allocate, allocationsPath, nextSpecNumberFrom, readAllocations, type AllocateOptions } from './allocate.ts';

/**
 * PLAN 4.2 — the hub allocator that actually reserves (D19 rung 2). `CEZ_HOME` is never touched on
 * `process.env`: every call below passes `options.env` explicitly, which is what lets the 6c burst
 * test below run many truly-concurrent calls against the SAME kind without one test case's global
 * env pin racing another's (the module-level vitest setup pins `process.env.CEZ_HOME` for the whole
 * worker, and mutating it per-test would be exactly the shared, racy global this suite is designed
 * to avoid depending on).
 */
describe('cluster/allocate', () => {
  let home: string;
  const nodeId = 'node-a' as ClusterNodeId;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-cluster-allocate-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function options(overrides: Partial<AllocateOptions> = {}): AllocateOptions {
    return { env: { ...process.env, CEZ_HOME: home }, ...overrides };
  }

  describe('allocationsPath', () => {
    it('is scoped under <CEZ_HOME>/cluster/allocations/<kind>.json', () => {
      const path = allocationsPath(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, { ...process.env, CEZ_HOME: home });
      expect(path).toBe(join(home, 'cluster', 'allocations', 'spec-number.json'));
    });

    it('rejects a kind that is not a safe filename component', () => {
      // The wire schema (`z.string().min(1).max(32)`) does not restrict characters — this layer
      // must, because `kind` becomes a filename. A path-traversal-shaped kind must never resolve.
      expect(() => allocationsPath('../../etc/passwd')).toThrow();
      expect(() => allocationsPath('spec number')).toThrow();
      expect(() => allocationsPath('')).toThrow();
    });
  });

  describe('nextSpecNumberFrom', () => {
    it('is one past the max of reserved and observed, unioned', () => {
      expect(nextSpecNumberFrom({ reserved: [], observed: [] })).toBe(1);
      expect(nextSpecNumberFrom({ reserved: [5], observed: [] })).toBe(6);
      expect(nextSpecNumberFrom({ reserved: [], observed: [417] })).toBe(418);
      // Neither half is sufficient alone: a number reserved a minute ago has no file yet (reserved
      // ahead of observed), and a spec written before the allocator existed has a file and no
      // reservation (observed ahead of reserved). The union must win either way.
      expect(nextSpecNumberFrom({ reserved: [10], observed: [3, 4, 5] })).toBe(11);
      expect(nextSpecNumberFrom({ reserved: [3, 4], observed: [20] })).toBe(21);
    });
  });

  describe('allocate', () => {
    it('reserves sequential values starting at 1 for a fresh kind', async () => {
      const first = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options());
      expect(first.values).toEqual(['1']);
      expect(first.kind).toBe(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER);
      expect(first.byNodeId).toBe(nodeId);

      const second = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options());
      expect(second.values).toEqual(['2']);
    });

    it('hands out `count` distinct sequential values in one call', async () => {
      const result = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, { count: 5 }, options());
      expect(result.values).toEqual(['1', '2', '3', '4', '5']);
    });

    it('an observed number above the ledger high-water mark pushes the next allocation past it', async () => {
      await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, { count: 3 }, options());
      // Ledger now holds 1, 2, 3. A caller-supplied observer reports a spec that already exists
      // on disk with no reservation behind it — the allocator must jump past it, not repeat it.
      const result = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options({ observe: () => [531] }));
      expect(result.values).toEqual(['532']);
    });

    it('negative control: the observer is consulted on every call, not just the first', async () => {
      // A bootstrap-seed-once implementation would pass the first assertion below and fail the
      // second, because it only reads `observe()` before the first allocation ever made under this
      // kind. This is the test the team lead asked for specifically to rule that design out.
      let observed: number[] = [];
      const observe = () => observed;

      const first = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options({ observe }));
      expect(first.values).toEqual(['1']);

      observed = [900]; // simulate a spec landing on disk from outside the allocator, between calls
      const second = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options({ observe }));
      expect(second.values).toEqual(['901']);
    });

    it('with no observer, behaves exactly as before (ledger only)', async () => {
      const result = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options());
      expect(result.values).toEqual(['1']);
    });

    it('records projectKey and reason with the allocation when supplied, and omits them when not', async () => {
      const withExtras = await allocate(
        CLUSTER_ALLOCATE_KIND_SPEC_NUMBER,
        nodeId,
        { projectKey: 'chat', reason: 'seed from bootstrap' },
        options(),
      );
      expect(withExtras.projectKey).toBe('chat');
      expect(withExtras.reason).toBe('seed from bootstrap');

      const withoutExtras = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options());
      expect(withoutExtras.projectKey).toBeUndefined();
      expect(withoutExtras.reason).toBeUndefined();
    });

    it('is generic over kind: two kinds keep independent counters, never a shared one', async () => {
      const specA = await allocate('spec-number', nodeId, {}, options());
      const specB = await allocate('spec-number', nodeId, {}, options());
      const workerA = await allocate('worker-slug', nodeId, {}, options());
      const workerB = await allocate('worker-slug', nodeId, {}, options());

      expect(specA.values).toEqual(['1']);
      expect(specB.values).toEqual(['2']);
      // If this shared a counter with `spec-number`, worker-slug's first value would be '3'/'4'
      // rather than restarting its own sequence at '1'.
      expect(workerA.values).toEqual(['1']);
      expect(workerB.values).toEqual(['2']);

      const specLedger = await readAllocations('spec-number', options());
      const workerLedger = await readAllocations('worker-slug', options());
      expect(specLedger).toHaveLength(2);
      expect(workerLedger).toHaveLength(2);
    });

    it('rejects an unsafe kind rather than falling back to a default/shared store', async () => {
      await expect(allocate('../spec-number', nodeId, {}, options())).rejects.toThrow();
    });

    it('a crashed caller burns the number rather than it being reclaimed', async () => {
      // There is no release/cancel API — that absence IS the design. Simulate a caller that
      // receives a value and never does anything with it (a crash before it writes the spec file),
      // then confirm the value never comes back out of a later call.
      const abandoned = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options());
      expect(abandoned.values).toEqual(['1']);

      const seen = new Set<string>(abandoned.values);
      for (let i = 0; i < 10; i++) {
        const next = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options());
        for (const v of next.values) {
          expect(seen.has(v)).toBe(false); // '1' must never resurface
          seen.add(v);
        }
      }
      expect([...seen].sort((a, b) => Number(a) - Number(b))).toEqual(
        Array.from({ length: 11 }, (_, i) => String(i + 1)),
      );
    });

    it('survives a restart: a fresh call (no in-memory state carried over) continues the sequence', async () => {
      await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, { count: 3 }, options());

      // Simulate "the hub process restarted" by clearing vitest's module registry and re-importing
      // fresh — this file keeps no module-level cache, so this should be behaviourally identical to
      // calling the same import again, but the fresh import proves that directly rather than
      // assuming it.
      vi.resetModules();
      const restarted = await import('./allocate.ts');
      const after = await restarted.allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options());
      expect(after.values).toEqual(['4']);

      const ledger = await readAllocations(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, options());
      expect(ledger.flatMap((e) => e.values)).toEqual(['1', '2', '3', '4']);
    });

    it('degrades a corrupt allocations file to empty with one warning, never throws', async () => {
      const path = allocationsPath(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, { ...process.env, CEZ_HOME: home });
      mkdirSync(join(home, 'cluster', 'allocations'), { recursive: true });
      writeFileSync(path, 'not json{{{');

      const warnings: string[] = [];
      const result = await allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options({ warn: (m) => warnings.push(m) }));

      expect(result.values).toEqual(['1']); // treated as a fresh ledger, not a thrown error
      expect(warnings.length).toBeGreaterThan(0);
      expect(existsSync(path)).toBe(true);
      // The corrupt content was replaced by the atomic write, not left behind.
      expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveLength(1);
    });

    // Verification 6c (D19 rung 2): N concurrent allocate calls must return N DISTINCT numbers,
    // asserted across the whole set — a pairwise check on two calls passes against an allocator
    // that repeats every third number, which is exactly the bug this test exists to catch. Run at
    // 24, well above the ">= 16" floor, on a machine shared with ~20 other agents.
    it('6c: N concurrent allocate calls return N distinct values, asserted across the whole set', async () => {
      const BURST = 24;
      const calls = Array.from({ length: BURST }, () => allocate(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, nodeId, {}, options()));
      const results = await Promise.all(calls);
      const values = results.flatMap((r) => r.values);

      expect(values).toHaveLength(BURST);
      expect(new Set(values).size).toBe(values.length);
      // Exact reservation, not merely distinct: the burst should have consumed precisely 1..BURST,
      // with no gaps and no repeats.
      expect([...new Set(values)].map(Number).sort((a, b) => a - b)).toEqual(
        Array.from({ length: BURST }, (_, i) => i + 1),
      );

      const ledger = await readAllocations(CLUSTER_ALLOCATE_KIND_SPEC_NUMBER, options());
      expect(ledger).toHaveLength(BURST); // one ledger entry per call, none lost
    });
  });
});
