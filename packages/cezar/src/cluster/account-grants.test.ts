import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClusterAccountGrant } from '@loki-labs/better-cezar-contract';
import {
  DEFAULT_ACCOUNT_GRANT_TTL_MS,
  clusterAccountUtilisation,
  readAccountGrants,
  reconcileUnattributed,
  releaseAccountGrant,
  reportAccountHold,
  requestAccountGrant,
} from './account-grants.ts';

/**
 * `cluster/account-grants.ts` (package 3.3 of `.ai/runs/2026-08-22-multi-node-cezar-cluster/PLAN.md`,
 * spec `.ai/specs/2026-08-22-multi-node-cezar-cluster.md`, D14 · §4). Verifies E6: dispatch from both
 * nodes at once shows one coherent utilisation, and a limit hold observed on one node parks the
 * other.
 *
 * Runs against the REAL `cluster/leases.ts` (package 3.1, already implemented) over a temp
 * `CEZ_HOME`, the same pattern `node-identity.test.ts` and `agent-account-usage.test.ts` use — this
 * is genuinely an integration test of the two files together, not a hand-rolled fake of the lease
 * primitive's renewal/fencing semantics.
 */
describe('cluster/account-grants', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-account-grants-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  const T0 = Date.parse('2026-08-22T00:00:00.000Z');
  const clockAt = (ms: number) => ({ now: () => new Date(ms) });

  it('grants a fresh request, with the default TTL when none is given', async () => {
    const decision = await requestAccountGrant(
      { accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' },
      clockAt(T0),
    );
    expect(decision).toEqual({
      granted: true,
      grant: {
        accountKey: 'claude:default',
        nodeId: 'node-a',
        runId: 'run-1',
        grantedAt: new Date(T0).toISOString(),
        expiresAt: new Date(T0 + DEFAULT_ACCOUNT_GRANT_TTL_MS).toISOString(),
      },
    });
  });

  it('refuses a blank accountKey as unknown-account', async () => {
    const decision = await requestAccountGrant({ accountKey: '   ', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));
    expect(decision).toEqual({ granted: false, reason: 'unknown-account' });
  });

  it('account-at-limit: a different node cannot take the exact same (account, run) grant while it is live', async () => {
    const first = await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));
    expect(first.granted).toBe(true);

    const second = await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-b', runId: 'run-1' }, clockAt(T0));
    expect(second.granted).toBe(false);
    if (!second.granted) {
      expect(second.reason).toBe('account-at-limit');
      expect(second.retryAt).toEqual(expect.any(String));
    }
  });

  it('no-lease: refuses rather than granting when the lease store cannot be reached (fail-closed)', async () => {
    // Block the directory `leases.ts` needs to create with a plain file at the same path, so its
    // `mkdirSync(dir, { recursive: true })` throws EEXIST instead of degrading — see leases.ts's
    // `acquireLeasesFileLock`. A read-only-home or corrupt-JSON failure degrades to empty inside
    // `leases.ts` itself and never reaches this file as an error; this is the one failure mode that
    // genuinely propagates.
    writeFileSync(join(home, 'cluster'), 'not a directory');
    const decision = await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));
    expect(decision).toEqual({ granted: false, reason: 'no-lease' });
  });

  describe('E6 — a limit hold observed on one node parks the other', () => {
    it('negative control: with no hold, a second node\'s request proceeds normally', async () => {
      const a = await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));
      const b = await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-b', runId: 'run-2' }, clockAt(T0));
      expect(a.granted).toBe(true);
      expect(b.granted).toBe(true);
    });

    it('a hold node A reports parks node B\'s request for the SAME account', async () => {
      await reportAccountHold(
        {
          accountKey: 'claude:default',
          nodeId: 'node-a',
          resetsAt: new Date(T0 + 3_000_000).toISOString(),
          observedAt: new Date(T0).toISOString(),
        },
        clockAt(T0),
      );

      const decision = await requestAccountGrant(
        { accountKey: 'claude:default', nodeId: 'node-b', runId: 'run-2' },
        clockAt(T0 + 1_000),
      );
      expect(decision).toEqual({
        granted: false,
        reason: 'limit-hold',
        retryAt: new Date(T0 + 3_000_000).toISOString(),
      });
    });

    it('does not park a request for a DIFFERENT account — the hold is keyed on accountKey, not global', async () => {
      await reportAccountHold(
        { accountKey: 'claude:default', nodeId: 'node-a', observedAt: new Date(T0).toISOString() },
        clockAt(T0),
      );
      const decision = await requestAccountGrant(
        { accountKey: 'codex:default', nodeId: 'node-b', runId: 'run-2' },
        clockAt(T0 + 1_000),
      );
      expect(decision.granted).toBe(true);
    });

    it('an expired hold no longer parks a new request', async () => {
      await reportAccountHold(
        {
          accountKey: 'claude:default',
          nodeId: 'node-a',
          resetsAt: new Date(T0 + 1_000).toISOString(),
          observedAt: new Date(T0).toISOString(),
        },
        clockAt(T0),
      );
      const decision = await requestAccountGrant(
        { accountKey: 'claude:default', nodeId: 'node-b', runId: 'run-2' },
        clockAt(T0 + 2_000),
      );
      expect(decision.granted).toBe(true);
    });

    it('with no stated resetsAt, the hold falls back to the bounded cooldown rather than lasting forever', async () => {
      await reportAccountHold(
        { accountKey: 'claude:default', nodeId: 'node-a', observedAt: new Date(T0).toISOString() },
        clockAt(T0),
      );
      // Just under an hour: still held.
      const stillHeld = await requestAccountGrant(
        { accountKey: 'claude:default', nodeId: 'node-b', runId: 'run-2' },
        clockAt(T0 + 59 * 60_000),
      );
      expect(stillHeld.granted).toBe(false);
      // Just past an hour: the bounded cooldown has lifted.
      const lifted = await requestAccountGrant(
        { accountKey: 'claude:default', nodeId: 'node-b', runId: 'run-3' },
        clockAt(T0 + 61 * 60_000),
      );
      expect(lifted.granted).toBe(true);
    });
  });

  describe('utilisation aggregates across nodes, rather than last-writer-wins', () => {
    it('sums live grants from multiple nodes into one figure — not one node\'s figure', async () => {
      await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));
      await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-2' }, clockAt(T0));
      await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-b', runId: 'run-3' }, clockAt(T0));

      const utilisation = await clusterAccountUtilisation(clockAt(T0));
      const claude = utilisation.find((u) => u.accountKey === 'claude:default');
      expect(claude).toBeDefined();
      // A last-writer-wins bug (keeping only the most recently seen lease per account) would report
      // 1 grant and one node here, not 3 across two — this is the assertion that catches it.
      expect(claude?.activeGrants).toBe(3);
      expect(claude?.byNode).toEqual({ 'node-a': 2, 'node-b': 1 });
    });

    it('a held-but-currently-idle account still appears, via holdUntil, with zero active grants', async () => {
      await reportAccountHold(
        {
          accountKey: 'claude:default',
          nodeId: 'node-a',
          resetsAt: new Date(T0 + 60_000).toISOString(),
          observedAt: new Date(T0).toISOString(),
        },
        clockAt(T0),
      );
      const utilisation = await clusterAccountUtilisation(clockAt(T0));
      const claude = utilisation.find((u) => u.accountKey === 'claude:default');
      expect(claude).toEqual({
        accountKey: 'claude:default',
        activeGrants: 0,
        byNode: {},
        holdUntil: new Date(T0 + 60_000).toISOString(),
      });
    });
  });

  describe('a stale report is not counted as current', () => {
    it('a grant past its own TTL is excluded from utilisation and readAccountGrants, even though nothing has swept it', async () => {
      await requestAccountGrant(
        { accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1', ttlMs: 1_000 },
        clockAt(T0),
      );
      // Read a full hour later, with no expireLeases sweep in between — the filtering has to happen
      // at read time in THIS file, not rely on the store having already evicted the row.
      const later = T0 + 60 * 60_000;
      const utilisation = await clusterAccountUtilisation(clockAt(later));
      expect(utilisation.find((u) => u.accountKey === 'claude:default')).toBeUndefined();

      const grants = await readAccountGrants(clockAt(later));
      expect(grants).toEqual([]);
    });
  });

  describe('releaseAccountGrant', () => {
    it('releases the grant matching (runId, nodeId), and returns false for a run it never held', async () => {
      await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));

      const releasedUnknown = await releaseAccountGrant('run-does-not-exist', 'node-a', clockAt(T0));
      expect(releasedUnknown).toBe(false);

      const released = await releaseAccountGrant('run-1', 'node-a', clockAt(T0));
      expect(released).toBe(true);

      const grants = await readAccountGrants(clockAt(T0));
      expect(grants).toEqual([]);
    });

    it('does not release a grant held by a different node', async () => {
      await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));
      const released = await releaseAccountGrant('run-1', 'node-b', clockAt(T0));
      expect(released).toBe(false);
      const grants = await readAccountGrants(clockAt(T0));
      expect(grants).toHaveLength(1);
    });
  });

  describe('readAccountGrants', () => {
    it('reflects exactly the live grants, across accounts and nodes', async () => {
      await requestAccountGrant({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }, clockAt(T0));
      await requestAccountGrant({ accountKey: 'codex:default', nodeId: 'node-b', runId: 'run-2' }, clockAt(T0));

      const grants = await readAccountGrants(clockAt(T0));
      expect(grants).toHaveLength(2);
      expect(grants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountKey: 'claude:default', nodeId: 'node-a', runId: 'run-1' }),
          expect.objectContaining({ accountKey: 'codex:default', nodeId: 'node-b', runId: 'run-2' }),
        ]),
      );
    });
  });

  describe('reconcileUnattributed (D15)', () => {
    it('absorbs a spoke\'s locally-balanced grants into the hub ledger', async () => {
      const grants: ClusterAccountGrant[] = [
        {
          accountKey: 'claude:default',
          nodeId: 'node-b',
          runId: 'run-9',
          grantedAt: new Date(T0).toISOString(),
          expiresAt: new Date(T0 + 60_000).toISOString(),
        },
      ];
      const count = await reconcileUnattributed('node-b', grants, clockAt(T0));
      expect(count).toBe(1);

      const utilisation = await clusterAccountUtilisation(clockAt(T0));
      expect(utilisation.find((u) => u.accountKey === 'claude:default')?.byNode).toEqual({ 'node-b': 1 });
    });

    it('skips a grant already expired by the time the link recovers — not forced into the ledger as a phantom', async () => {
      const grants: ClusterAccountGrant[] = [
        {
          accountKey: 'claude:default',
          nodeId: 'node-b',
          runId: 'run-10',
          grantedAt: new Date(T0 - 10_000).toISOString(),
          expiresAt: new Date(T0 - 1_000).toISOString(),
        },
      ];
      const count = await reconcileUnattributed('node-b', grants, clockAt(T0));
      expect(count).toBe(0);
    });

    it('skips a grant attributed to a different node than the one reconciling', async () => {
      const grants: ClusterAccountGrant[] = [
        {
          accountKey: 'claude:default',
          nodeId: 'node-other',
          runId: 'run-11',
          grantedAt: new Date(T0).toISOString(),
          expiresAt: new Date(T0 + 60_000).toISOString(),
        },
      ];
      const count = await reconcileUnattributed('node-b', grants, clockAt(T0));
      expect(count).toBe(0);
    });
  });
});
