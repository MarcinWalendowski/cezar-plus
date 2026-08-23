import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureNodeIdentity } from '../cluster/node-identity.ts';
import type { UpgradeCapableServer } from '../cluster/link-server.ts';
import {
  createOpHistoryStore,
  opHistoryPath,
  OP_HISTORY_PRUNE_INTERVAL_MS,
  OP_HISTORY_RETENTION_MS,
} from '../cluster/op-history.ts';
import { startClusterRuntime } from './cluster-routes.ts';

/**
 * B2a — the timer `startClusterRuntime`'s hub branch arms to sweep `op-history.ts`'s durable
 * per-`opId` verdict cache. Before this, `OpHistoryStore.prune()` had five callers, all in its own
 * test file, and zero in production (`grep -arn '\.prune(' packages/cezar/src packages/contract/src`
 * — confirmed during recon). This file proves the timer that gives it a real caller.
 *
 * `Date` and the interval APIs are faked, everything else is left real (`toFake: ['Date',
 * 'setInterval', 'clearInterval']`, matching `health-topic.test.ts`'s own precedent for why a
 * blanket `vi.useFakeTimers()` is wrong here): the code under test does real fs I/O
 * (`loadNodeIdentity`, the op-history lease's `setTimeout`-based retry sleep at
 * `op-history.ts:259`), and faking `setTimeout` too would leave nothing to advance those awaits —
 * the suite would deadlock rather than run faster. Faking `setInterval` is the one thing this file
 * actually needs to control (when the recurring sweep fires); faking `Date` is what lets the
 * seeded ages and `OP_HISTORY_RETENTION_MS` cross without a real 30-day wait.
 */
function fakeUpgradeServer(): UpgradeCapableServer {
  return createServer();
}

describe('B2a — the op-history prune timer', () => {
  let home: string;
  const savedCluster = process.env.CEZ_CLUSTER;
  const savedHub = process.env.CEZ_CLUSTER_HUB;
  const savedHome = process.env.CEZ_HOME;
  const disposers: Array<() => void> = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    home = mkdtempSync(join(tmpdir(), 'cez-prune-timer-home-'));
    delete process.env.CEZ_CLUSTER_HUB; // no CEZ_CLUSTER_HUB ⇒ hub, per D1
    process.env.CEZ_CLUSTER = '1';
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
    if (savedCluster === undefined) delete process.env.CEZ_CLUSTER;
    else process.env.CEZ_CLUSTER = savedCluster;
    if (savedHub === undefined) delete process.env.CEZ_CLUSTER_HUB;
    else process.env.CEZ_CLUSTER_HUB = savedHub;
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  /**
   * Also the target of B3's required negative control for this timer: run this test ALONE
   * against a source mutation that deletes the `pruneTimer = setInterval(pruneOnce,
   * OP_HISTORY_PRUNE_INTERVAL_MS)` line in `cluster-routes.ts` (leaving the arm-time `pruneOnce()`
   * call in place) — `boundary-op` is seeded to SURVIVE the arm-time sweep, so with the interval
   * gone it never gets removed and the final assertion goes RED. See the B3 implementation report
   * for the mutation, the quoted RED assertion, and the restore.
   */
  it('sweeps on arm, and again every OP_HISTORY_PRUNE_INTERVAL_MS, dropping only what has crossed retention', async () => {
    await ensureNodeIdentity({ role: 'hub' });

    // Seeded with `now` overrides so ages are exact and independent of wall-clock drift while this
    // test runs. `boundary-op` starts 12h SHORT of retention (must survive the arm-time sweep) and
    // crosses it only after one PRUNE_INTERVAL (24h) elapses. `fresh-op`, recorded at T0, is still
    // only 24h old after the same advance — nowhere near the 30-day window — and must survive both
    // sweeps, so a guard that pruned everything indiscriminately would still be caught.
    const t0 = Date.now();
    const seedStore = createOpHistoryStore({
      env: process.env,
      now: () => new Date(t0 - (OP_HISTORY_RETENTION_MS - 12 * 60 * 60_000)),
    });
    await seedStore.record('boundary-op', { opId: 'boundary-op', hubSeq: 1, accepted: true });
    const seedStoreFresh = createOpHistoryStore({ env: process.env, now: () => new Date(t0) });
    await seedStoreFresh.record('fresh-op', { opId: 'fresh-op', hubSeq: 2, accepted: true });

    const warn = vi.fn();
    const stop = startClusterRuntime({ version: '0.0.0-test', warn, server: fakeUpgradeServer() });
    disposers.push(stop);

    const readStore = createOpHistoryStore({ env: process.env });

    // Let the one async step (`loadNodeIdentity`'s real `readFile`) resolve and the arm-time
    // `pruneOnce()` run to completion — `setTimeout` is real in this suite (see module docblock),
    // so `vi.waitFor`'s own polling still works even though the interval is faked.
    await vi.waitFor(async () => {
      expect(await readStore.find('boundary-op')).toBeDefined();
    });
    // Arm-time sweep: neither entry has crossed retention yet.
    await expect(readStore.find('fresh-op')).resolves.toBeDefined();

    // One full interval — the RECURRING sweep, not the arm-time one, is what removes `boundary-op`
    // once it crosses the 30-day window; `fresh-op` (now 24h old) is nowhere close and must survive.
    await vi.advanceTimersByTimeAsync(OP_HISTORY_PRUNE_INTERVAL_MS);
    await vi.waitFor(async () => {
      expect(await readStore.find('boundary-op')).toBeUndefined();
    });
    await expect(readStore.find('fresh-op')).resolves.toBeDefined();
  });

  it('negative control: a prune() rejection (whole-file corruption) is caught, warned, and does not stop the hub', async () => {
    await ensureNodeIdentity({ role: 'hub' });
    // Whole-file corruption — `readOpHistoryFile` cannot parse this at all, so `prune()` REJECTS
    // (op-history.ts's own "Corruption" section). Written before arming, so the very first sweep
    // (on arm) hits it.
    writeFileSync(opHistoryPath(process.env), 'not valid json {{{', 'utf8');

    const warn = vi.fn();
    const stop = startClusterRuntime({ version: '0.0.0-test', warn, server: fakeUpgradeServer() });
    disposers.push(stop);

    // The rejection was caught (not an unhandled rejection that would have brought vitest itself
    // down) and named by the sweep's own `.catch`, not swallowed silently.
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('op-history prune failed'));
    });
    // The hub is still up — `stop()` runs cleanly, proving the timer/link were never torn down by
    // the rejection.
    expect(() => stop()).not.toThrow();
  });
});
