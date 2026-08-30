import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterLease } from '@loki-labs/cezar-plus-contract';
import { clusterHomeDir } from './node-identity.ts';
import {
  DEFAULT_LEASE_TTL_MS,
  acquireLease,
  expireLeases,
  leasesHeldBy,
  leasesPath,
  reassertLeases,
  readLeases,
  releaseLease,
} from './leases.ts';

/**
 * `~/.cezar/cluster/leases.json` (package 3.1 of
 * `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`, spec
 * `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14 · D15b).
 */
describe('cluster/leases', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-leases-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('leasesPath lives under <CEZ_HOME>/cluster/leases.json', () => {
    expect(leasesPath()).toBe(join(clusterHomeDir(), 'leases.json'));
  });

  describe('acquire / release round trip', () => {
    it('grants an unheld resource and releases it back to unheld', async () => {
      const res = await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: DEFAULT_LEASE_TTL_MS });
      expect(res.acquired).toBe(true);
      if (!res.acquired) throw new Error('unreachable');
      expect(res.lease.holderNodeId).toBe('node-a');
      expect(res.lease.kind).toBe('scheduler');

      expect(await releaseLease('scheduler', 'automations', 'node-a')).toBe(true);
      expect(await readLeases()).toEqual([]);
    });

    it('release returns false when this node is not the recorded holder, and leaves the row untouched', async () => {
      await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: DEFAULT_LEASE_TTL_MS });
      expect(await releaseLease('scheduler', 'automations', 'node-b')).toBe(false);
      expect(await readLeases()).toHaveLength(1);
    });

    it('release of a resource nobody holds returns false', async () => {
      expect(await releaseLease('scheduler', 'nothing-here', 'node-a')).toBe(false);
    });
  });

  // Negative control 1: a lease actually excludes, asserted across a burst rather than two callers
  // — a racy implementation usually gets two right.
  describe('mutual exclusion under a burst', () => {
    it('exactly one of many concurrent acquires for the same key wins, and every loser names the winner', async () => {
      const contenders = Array.from({ length: 16 }, (_, i) => `node-${i}`);
      const results = await Promise.all(
        contenders.map((nodeId) => acquireLease('scheduler', nodeId, { id: 'automations', ttlMs: DEFAULT_LEASE_TTL_MS })),
      );

      const winners = results.filter((r) => r.acquired);
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;
      if (!winner.acquired) throw new Error('unreachable');

      const losers = results.filter((r) => !r.acquired);
      expect(losers).toHaveLength(contenders.length - 1);
      for (const loser of losers) {
        if (loser.acquired) throw new Error('unreachable');
        expect(loser.heldBy).toBe(winner.lease.holderNodeId);
      }

      const held = await leasesHeldBy(winner.lease.holderNodeId);
      expect(held).toHaveLength(1);
      expect(held[0]!.id).toBe('automations');
    });
  });

  // Negative control 2: expiry releases, and a renewal genuinely extends the hold rather than
  // just resetting a clock nobody checks.
  describe('expiry', () => {
    it('an un-renewed lease becomes acquirable after its TTL, and a renewed one does not', async () => {
      let clock = new Date('2026-08-22T00:00:00.000Z');
      const now = () => clock;

      const first = await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: 1_000 }, { now });
      expect(first.acquired).toBe(true);
      if (!first.acquired) throw new Error('unreachable');

      // Renew well before the original TTL, proving the current epoch with its fencing token.
      clock = new Date(clock.getTime() + 500);
      const renewed = await acquireLease(
        'scheduler',
        'node-a',
        { id: 'automations', ttlMs: 5_000, fencingToken: first.lease.fencingToken },
        { now },
      );
      expect(renewed.acquired).toBe(true);
      if (!renewed.acquired) throw new Error('unreachable');
      expect(renewed.lease.fencingToken).toBe(first.lease.fencingToken); // same epoch, just extended

      // Past the ORIGINAL ttl but inside the renewed one — a competitor is still refused.
      clock = new Date(clock.getTime() + 1_000);
      const tooEarly = await acquireLease('scheduler', 'node-b', { id: 'automations', ttlMs: 1_000 }, { now });
      expect(tooEarly.acquired).toBe(false);

      // Past the renewed ttl — now genuinely free.
      clock = new Date(clock.getTime() + 6_000);
      const afterExpiry = await acquireLease('scheduler', 'node-b', { id: 'automations', ttlMs: 1_000 }, { now });
      expect(afterExpiry.acquired).toBe(true);
    });
  });

  // Negative control 2b: `leasesHeldBy` must itself apply the liveness filter, not just return
  // whatever rows carry the node's id. A prior version of this suite deleted that filter's
  // conjunct in `leases.ts` and stayed green, because every caller in this file only ever asked
  // `leasesHeldBy` about a store where every row was still live — "returns live leases" and
  // "returns all leases" were indistinguishable. This drives the SAME node's clock past one
  // lease's TTL while a second lease it holds is still live, so the expired-and-absent case and
  // the live-and-returned case (the mirror control) are both exercised in one assertion.
  describe('leasesHeldBy filters on liveness', () => {
    it('excludes a lease past its TTL and still returns one that is live, for the same holder', async () => {
      let clock = new Date('2026-08-22T00:00:00.000Z');
      const now = () => clock;

      const short = await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: 1_000 }, { now });
      expect(short.acquired).toBe(true);
      const long = await acquireLease('account', 'node-a', { id: 'acct-1', ttlMs: 100_000 }, { now });
      expect(long.acquired).toBe(true);

      // Past the short lease's TTL, well inside the long lease's.
      clock = new Date(clock.getTime() + 2_000);

      const held = await leasesHeldBy('node-a', { now });
      expect(held).toHaveLength(1); // the expired 'automations' lease must not appear
      expect(held[0]!.id).toBe('acct-1'); // mirror control: the still-live lease is returned
    });
  });

  // Negative control 3, the unit-level analogue of Verification 10 ("exactly-once across a lease
  // wipe"). The full property (a replicated todo claim survives a wiped hub) is architectural —
  // D4/D9a moved claims off leases entirely, onto the hub's linearized ack, which is not this
  // module's job to prove. What IS this module's job: prove that losing the store never wedges,
  // never throws, and — the part that would silently break exclusion — never lets a stale holder
  // talk its way back over a node that legitimately re-acquired in the gap.
  describe('losing the store', () => {
    it('does not let a stale reassertion override the node that legitimately re-acquired after the wipe', async () => {
      const claimA = await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: DEFAULT_LEASE_TTL_MS });
      expect(claimA.acquired).toBe(true);
      if (!claimA.acquired) throw new Error('unreachable');

      // Simulate a blue-green hub restart that wipes the lease store entirely.
      rmSync(leasesPath(), { force: true });
      expect(await readLeases()).toEqual([]);

      // A second node proceeds — a wiped store degrades to "unheld", never a hang or a throw.
      const claimB = await acquireLease('scheduler', 'node-b', { id: 'automations', ttlMs: DEFAULT_LEASE_TTL_MS });
      expect(claimB.acquired).toBe(true);
      if (!claimB.acquired) throw new Error('unreachable');

      // Monotonicity survives the wipe: B's epoch is strictly newer than A's, even though nothing
      // on disk remembered A's token.
      expect(claimB.lease.fencingToken).toBeGreaterThan(claimA.lease.fencingToken);

      // node-a reconnects and reasserts what it remembers holding. It must NOT get it back —
      // node-b already, legitimately, holds it. Silently honouring this would be exactly the
      // double-grant Verification 10 exists to rule out, recast for the resources this module
      // actually guards (account grants, usage aggregation, limit holds, scheduler ticks).
      expect(await reassertLeases('node-a', [claimA.lease])).toEqual([]);

      // The durable truth reflects node-b, not the amnesiac node-a.
      expect(await leasesHeldBy('node-a')).toEqual([]);
      const heldByB = await leasesHeldBy('node-b');
      expect(heldByB).toHaveLength(1);
      expect(heldByB[0]!.fencingToken).toBe(claimB.lease.fencingToken);
    });

    it('honours a reassertion when nobody has raced in — the self-healing half of "losing them is survivable"', async () => {
      const claimA = await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: DEFAULT_LEASE_TTL_MS });
      expect(claimA.acquired).toBe(true);
      if (!claimA.acquired) throw new Error('unreachable');

      rmSync(leasesPath(), { force: true });

      const reasserted = await reassertLeases('node-a', [claimA.lease]);
      expect(reasserted).toHaveLength(1);
      expect(reasserted[0]!.holderNodeId).toBe('node-a');
      // A new epoch, not a resumption of the one the wipe erased.
      expect(reasserted[0]!.fencingToken).toBeGreaterThan(claimA.lease.fencingToken);

      expect(await leasesHeldBy('node-a')).toHaveLength(1);
    });

    it('reassertLeases renews in place, same epoch, when the store survived and nothing raced in', async () => {
      const claimA = await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: DEFAULT_LEASE_TTL_MS });
      expect(claimA.acquired).toBe(true);
      if (!claimA.acquired) throw new Error('unreachable');

      const reasserted = await reassertLeases('node-a', [claimA.lease]);
      expect(reasserted).toHaveLength(1);
      expect(reasserted[0]!.fencingToken).toBe(claimA.lease.fencingToken); // continuous, not a new epoch
    });
  });

  describe('corrupt store degrades to empty, per-entry salvage, and never fails boot', () => {
    it('degrades to empty with one warning on unparsable JSON', async () => {
      mkdirSync(clusterHomeDir(), { recursive: true });
      writeFileSync(leasesPath(), '{not json');
      const warnings: string[] = [];
      const rows = await readLeases({ warn: (m) => warnings.push(m) });
      expect(rows).toEqual([]);
      expect(warnings).toHaveLength(1);
    });

    it('salvages valid rows and skips a malformed one, with one warning', async () => {
      mkdirSync(clusterHomeDir(), { recursive: true });
      const good: ClusterLease = {
        kind: 'scheduler',
        id: 'automations',
        holderNodeId: 'node-a',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        fencingToken: 1,
      };
      writeFileSync(leasesPath(), JSON.stringify({ leases: [good, { bogus: true }] }));
      const warnings: string[] = [];
      const rows = await readLeases({ warn: (m) => warnings.push(m) });
      expect(rows).toEqual([good]);
      expect(warnings).toHaveLength(1);
    });
  });

  describe('expireLeases', () => {
    it('sweeps only expired rows and reports how many', async () => {
      let clock = new Date('2026-08-22T00:00:00.000Z');
      const now = () => clock;
      await acquireLease('scheduler', 'node-a', { id: 'automations', ttlMs: 1_000 }, { now });
      await acquireLease('account', 'node-b', { id: 'acct-1', ttlMs: 100_000 }, { now });

      clock = new Date(clock.getTime() + 2_000);
      expect(await expireLeases({ now })).toBe(1);

      const rows = await readLeases();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('acct-1');
    });
  });
});
