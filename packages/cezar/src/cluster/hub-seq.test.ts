import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterHomeOptions } from './node-identity.ts';
import { clusterHomeDir } from './node-identity.ts';
import { createHubSeqAllocator, hubSeqPath } from './hub-seq.ts';

/**
 * The hub's `hubSeq` allocator (D4 of `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, the one
 * piece the spec's own Milestone B table lists as "does not exist anywhere"). `CEZ_HOME` is never
 * mutated on `process.env` — every call passes `options.env` explicitly, matching `allocate.test.ts`
 * 6c's own reasoning: it is what lets the burst test below fire many truly-concurrent calls without
 * one test's global env pin racing another's.
 */
describe('cluster/hub-seq', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-hub-seq-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function options(overrides: Partial<ClusterHomeOptions> = {}): ClusterHomeOptions {
    return { env: { ...process.env, CEZ_HOME: home }, ...overrides };
  }

  it('hubSeqPath lives under <CEZ_HOME>/cluster/hub-seq.json', () => {
    expect(hubSeqPath(options().env)).toBe(join(clusterHomeDir(options().env), 'hub-seq.json'));
  });

  describe('allocate / current — basic contract', () => {
    it('current() is 0 for a key that has never allocated, without creating the file', async () => {
      const allocator = createHubSeqAllocator(options());
      expect(await allocator.current({ scope: 'workspace' })).toBe(0);
      expect(existsSync(hubSeqPath(options().env))).toBe(false);
    });

    it('the first allocate() for a key starts at 1 and returns an inclusive range', async () => {
      const allocator = createHubSeqAllocator(options());
      expect(await allocator.allocate({ scope: 'workspace', count: 5 })).toEqual({ from: 1, to: 5 });
      expect(await allocator.current({ scope: 'workspace' })).toBe(5);
    });

    it('sequential allocations are contiguous, no gaps and no overlap', async () => {
      const allocator = createHubSeqAllocator(options());
      expect(await allocator.allocate({ scope: 'workspace', count: 3 })).toEqual({ from: 1, to: 3 });
      expect(await allocator.allocate({ scope: 'workspace', count: 4 })).toEqual({ from: 4, to: 7 });
      expect(await allocator.allocate({ scope: 'workspace', count: 1 })).toEqual({ from: 8, to: 8 });
    });

    it('two different project keys, and the workspace key, each keep an independent sequence', async () => {
      const allocator = createHubSeqAllocator(options());
      expect(await allocator.allocate({ scope: 'project', projectKey: 'proj-a', count: 3 })).toEqual({ from: 1, to: 3 });
      expect(await allocator.allocate({ scope: 'project', projectKey: 'proj-b', count: 2 })).toEqual({ from: 1, to: 2 });
      expect(await allocator.allocate({ scope: 'workspace', count: 1 })).toEqual({ from: 1, to: 1 });
      // Advancing one key must never move another.
      expect(await allocator.allocate({ scope: 'project', projectKey: 'proj-a', count: 1 })).toEqual({ from: 4, to: 4 });
      expect(await allocator.current({ scope: 'project', projectKey: 'proj-b' })).toBe(2);
      expect(await allocator.current({ scope: 'workspace' })).toBe(1);
    });

    it('scope "workspace" ignores a stray projectKey — same counter as no projectKey at all', async () => {
      const allocator = createHubSeqAllocator(options());
      expect(await allocator.allocate({ scope: 'workspace', projectKey: 'stray', count: 2 })).toEqual({ from: 1, to: 2 });
      expect(await allocator.current({ scope: 'workspace' })).toBe(2);
      expect(await allocator.current({ scope: 'workspace', projectKey: 'different-stray' })).toBe(2);
    });

    it('scope "project" with no projectKey is a caller error — allocate() and current() both throw', async () => {
      const allocator = createHubSeqAllocator(options());
      await expect(allocator.allocate({ scope: 'project', count: 1 })).rejects.toThrow(/projectKey/);
      await expect(allocator.current({ scope: 'project' })).rejects.toThrow(/projectKey/);
    });

    it('a negative or non-integer count throws rather than allocating', async () => {
      const allocator = createHubSeqAllocator(options());
      await expect(allocator.allocate({ scope: 'workspace', count: -1 })).rejects.toThrow(/non-negative integer/);
      await expect(allocator.allocate({ scope: 'workspace', count: 1.5 })).rejects.toThrow(/non-negative integer/);
      await expect(allocator.allocate({ scope: 'workspace', count: Number.NaN })).rejects.toThrow(/non-negative integer/);
    });

    it('count: 0 is a no-op — empty range, no counter movement, no file written', async () => {
      const allocator = createHubSeqAllocator(options());
      expect(await allocator.allocate({ scope: 'workspace', count: 0 })).toEqual({ from: 1, to: 0 }); // empty: to < from
      expect(existsSync(hubSeqPath(options().env))).toBe(false);
      // A real allocation right after sees the SAME starting point the no-op reported — nothing
      // was consumed by the count:0 call.
      expect(await allocator.allocate({ scope: 'workspace', count: 1 })).toEqual({ from: 1, to: 1 });
    });

    it('count: 0 after real allocations still reports the current base, untouched', async () => {
      const allocator = createHubSeqAllocator(options());
      await allocator.allocate({ scope: 'workspace', count: 5 });
      expect(await allocator.allocate({ scope: 'workspace', count: 0 })).toEqual({ from: 6, to: 5 });
      expect(await allocator.current({ scope: 'workspace' })).toBe(5);
    });
  });

  describe('monotonic across a simulated process restart', () => {
    it('a fresh allocator against the same home continues exactly where the old one stopped', async () => {
      const first = createHubSeqAllocator(options());
      const before = await first.allocate({ scope: 'project', projectKey: 'proj-a', count: 7 });
      expect(before).toEqual({ from: 1, to: 7 });

      // Throw the allocator away and build a brand new one — nothing but the on-disk file connects
      // them, simulating the hub's blue-green restart (spec: ~10x/day).
      const second = createHubSeqAllocator(options());
      const after = await second.allocate({ scope: 'project', projectKey: 'proj-a', count: 3 });

      expect(after.from).toBeGreaterThan(before.to); // strictly increasing, no overlap
      expect(after).toEqual({ from: 8, to: 10 });
      expect(await second.current({ scope: 'project', projectKey: 'proj-a' })).toBe(10);
    });
  });

  describe('N concurrent allocate calls — no duplicates, no gaps, across the whole set', () => {
    // Verification (spec brief): fire N concurrent calls with varying `count`s and assert the UNION
    // of returned ranges has no duplicates and no gaps — a pairwise check on two calls would pass
    // against an allocator missing its write lease, which loses updates under a torn read-modify-
    // write far more often than it produces an outright crash.
    it('BURST concurrent calls of varying size tile 1..total with no overlap', async () => {
      const allocator = createHubSeqAllocator(options());
      const counts = Array.from({ length: 24 }, (_, i) => (i % 3) + 1); // 1, 2 or 3 each
      const total = counts.reduce((a, b) => a + b, 0);

      const ranges = await Promise.all(counts.map((count) => allocator.allocate({ scope: 'workspace', count })));

      // Every range internally consistent (to - from + 1 === requested count).
      ranges.forEach((range, i) => expect(range.to - range.from + 1).toBe(counts[i]));

      // Flatten every range to its individual numbers and assert the union is EXACTLY 1..total —
      // distinct (no duplicate handed out twice) and complete (no gap left behind).
      const numbers = ranges.flatMap((range) => Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i));
      expect(numbers).toHaveLength(total);
      expect(new Set(numbers).size).toBe(total); // no duplicates
      expect([...new Set(numbers)].sort((a, b) => a - b)).toEqual(Array.from({ length: total }, (_, i) => i + 1)); // no gaps

      expect(await allocator.current({ scope: 'workspace' })).toBe(total);
    });

    it('concurrent bursts on two DIFFERENT keys do not interleave into each other', async () => {
      const allocator = createHubSeqAllocator(options());
      const [aRanges, bRanges] = await Promise.all([
        Promise.all(Array.from({ length: 12 }, () => allocator.allocate({ scope: 'project', projectKey: 'proj-a', count: 1 }))),
        Promise.all(Array.from({ length: 12 }, () => allocator.allocate({ scope: 'project', projectKey: 'proj-b', count: 1 }))),
      ]);
      const aValues = aRanges.map((r) => r.from).sort((x, y) => x - y);
      const bValues = bRanges.map((r) => r.from).sort((x, y) => x - y);
      expect(aValues).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(bValues).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    });
  });

  describe('corruption — fail closed, never reuse a number (spec brief requirement 3)', () => {
    it('a whole-file-corrupt store refuses EVERY key, including ones untouched by the corruption', async () => {
      const allocator = createHubSeqAllocator(options());
      await allocator.allocate({ scope: 'workspace', count: 5 });
      mkdirSync(clusterHomeDir(options().env), { recursive: true });
      writeFileSync(hubSeqPath(options().env), 'not json{{{', 'utf8');

      const warnings: string[] = [];
      const warned = createHubSeqAllocator(options({ warn: (m) => warnings.push(m) }));
      await expect(warned.current({ scope: 'workspace' })).rejects.toThrow(/corrupt/);
      await expect(warned.allocate({ scope: 'workspace', count: 1 })).rejects.toThrow(/corrupt/);
      // A key that was NEVER written is refused too — the whole file is untrustworthy, not just the
      // one key that happened to be corrupted.
      await expect(warned.current({ scope: 'project', projectKey: 'never-touched' })).rejects.toThrow(/corrupt/);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('a poisoned single entry refuses only that key, and does not hand back a number already given out', async () => {
      const allocator = createHubSeqAllocator(options());
      const before = await allocator.allocate({ scope: 'workspace', count: 5 });
      expect(before).toEqual({ from: 1, to: 5 });

      // Corrupt ONLY the "workspace" entry, in place, leaving valid JSON.
      const path = hubSeqPath(options().env);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { counters: Record<string, unknown> };
      onDisk.counters.workspace = 'not-a-number';
      writeFileSync(path, JSON.stringify(onDisk), 'utf8');

      const warnings: string[] = [];
      const warned = createHubSeqAllocator(options({ warn: (m) => warnings.push(m) }));
      // The critical assertion: this must NOT succeed and hand back a range starting at 1 again,
      // which would collide with the 1..5 already handed out above.
      await expect(warned.allocate({ scope: 'workspace', count: 1 })).rejects.toThrow(/unreadable/);
      await expect(warned.current({ scope: 'workspace' })).rejects.toThrow(/unreadable/);
      expect(warnings.length).toBeGreaterThan(0);
    });

    it('a poisoned entry for one key does not block a DIFFERENT, healthy key', async () => {
      const allocator = createHubSeqAllocator(options());
      await allocator.allocate({ scope: 'project', projectKey: 'proj-a', count: 2 });
      await allocator.allocate({ scope: 'project', projectKey: 'proj-b', count: 2 });

      const path = hubSeqPath(options().env);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { counters: Record<string, unknown> };
      onDisk.counters['project:proj-a'] = -1; // negative — not a legal hubSeq value
      writeFileSync(path, JSON.stringify(onDisk), 'utf8');

      const fresh = createHubSeqAllocator(options());
      await expect(fresh.current({ scope: 'project', projectKey: 'proj-a' })).rejects.toThrow(/unreadable/);
      // proj-b is untouched and keeps working.
      expect(await fresh.current({ scope: 'project', projectKey: 'proj-b' })).toBe(2);
      expect(await fresh.allocate({ scope: 'project', projectKey: 'proj-b', count: 1 })).toEqual({ from: 3, to: 3 });
    });

    it('a write for a healthy key preserves a sibling poisoned entry VERBATIM rather than healing it to absent', async () => {
      const allocator = createHubSeqAllocator(options());
      await allocator.allocate({ scope: 'project', projectKey: 'proj-a', count: 1 });
      await allocator.allocate({ scope: 'workspace', count: 1 });

      const path = hubSeqPath(options().env);
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { counters: Record<string, unknown> };
      onDisk.counters['project:proj-a'] = { nested: 'garbage' };
      writeFileSync(path, JSON.stringify(onDisk), 'utf8');

      const fresh = createHubSeqAllocator(options());
      // Advance the HEALTHY key — this writes the file again.
      await fresh.allocate({ scope: 'workspace', count: 1 });

      // The poisoned entry must still be there, unchanged — dropping it would silently heal it back
      // to "absent," which reads as 0 on the next read and reopens the reuse hole.
      const after = JSON.parse(readFileSync(path, 'utf8')) as { counters: Record<string, unknown> };
      expect(after.counters['project:proj-a']).toEqual({ nested: 'garbage' });
      await expect(fresh.current({ scope: 'project', projectKey: 'proj-a' })).rejects.toThrow(/unreadable/);
    });
  });
});
