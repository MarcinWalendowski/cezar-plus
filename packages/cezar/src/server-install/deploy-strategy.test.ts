import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runGatedDeploy, runRollback, type DeployEffects, type DeployEvent } from './deploy-strategy.ts';
import { currentTarget, loadLedger, releaseDir, saveLedger } from './releases.ts';

/**
 * P5 of `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`.
 *
 * The cases that matter are the failing ones — a deploy that goes right needs no orchestration.
 * So: a bad build must never flip, and a build that boots then fails readiness must put the old
 * one back without a human.
 */

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cez-deploy-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function harness(over: Partial<DeployEffects> = {}) {
  const root = scratch();
  const releasesDir = join(root, 'releases');
  const linkPath = join(root, 'cezar');
  const events: DeployEvent[] = [];
  const restart = vi.fn(async () => {});
  const fx: DeployEffects = {
    stage: async (dir) => {
      mkdirSync(dir, { recursive: true });
    },
    smokeBoot: async () => ({ ok: true }),
    restart,
    probeReady: async () => ({ ok: true }),
    emit: (e) => events.push(e),
    now: () => '2026-08-20T10:00:00.000Z',
    inflightRuns: () => 3,
    ...over,
  };
  return { root, releasesDir, linkPath, events, restart, fx };
}

/** Land a healthy release so later cases have something to roll back TO. */
async function seedCurrent(h: ReturnType<typeof harness>, id: string) {
  await runGatedDeploy({ releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id } }, h.fx);
}

describe('a healthy deploy', () => {
  it('stages, smoke-boots, flips, restarts and probes — in that order', async () => {
    const order: string[] = [];
    const h = harness({
      stage: async (dir) => {
        order.push('stage');
        mkdirSync(dir, { recursive: true });
      },
      smokeBoot: async () => {
        order.push('smoke');
        return { ok: true };
      },
      restart: async () => {
        order.push('restart');
      },
      probeReady: async () => {
        order.push('probe');
        return { ok: true };
      },
    });
    const out = await runGatedDeploy({ releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id: 'r1' } }, h.fx);

    expect(out.ok).toBe(true);
    expect(order).toEqual(['stage', 'smoke', 'restart', 'probe']);
    expect(currentTarget(h.linkPath)).toBe(releaseDir(h.releasesDir, 'r1'));
    expect(loadLedger(h.releasesDir).current).toBe('r1');
    expect(loadLedger(h.releasesDir).releases.find((r) => r.id === 'r1')?.healthy).toBe(true);
  });

  it('emits the analytics the spec names, with the two numbers that define non-disruptive', async () => {
    const h = harness();
    await runGatedDeploy(
      { releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id: 'r1', version: '0.10.0', sha: 'abc' } },
      h.fx,
    );
    expect(h.events.map((e) => e.name)).toEqual([
      'deploy.started',
      'deploy.release_built',
      'deploy.instance_ready',
      'deploy.cutover',
      'deploy.drained',
    ]);
    const cutover = h.events.find((e) => e.name === 'deploy.cutover');
    expect(cutover?.inflightRuns).toBe(3);
    expect(typeof cutover?.gapMs).toBe('number');
    expect(h.events[0]?.version).toBe('0.10.0');
    expect(h.events[0]?.sha).toBe('abc');
  });
});

describe('gate 1 — a bad build never reaches production', () => {
  it('does not flip, does not restart, and leaves the running release untouched', async () => {
    const h = harness();
    await seedCurrent(h, 'good');
    h.restart.mockClear();

    const failing = harness({ ...h.fx, smokeBoot: async () => ({ ok: false, detail: 'dist/index.js is truncated' }) });
    // reuse the same box paths as the seeded deploy
    const out = await runGatedDeploy(
      { releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id: 'bad' } },
      { ...failing.fx, emit: (e) => h.events.push(e), restart: h.restart },
    );

    expect(out.ok).toBe(false);
    expect(out.failedAt).toBe('smoke_boot');
    expect(h.restart).not.toHaveBeenCalled();
    expect(currentTarget(h.linkPath)).toBe(releaseDir(h.releasesDir, 'good'));
    expect(loadLedger(h.releasesDir).current).toBe('good');
    expect(h.events.at(-1)).toMatchObject({ name: 'deploy.rollback', failedAt: 'smoke_boot' });
  });

  it('records the release as unhealthy so a later deploy can see it failed', async () => {
    const h = harness({ smokeBoot: async () => ({ ok: false, detail: 'nope' }) });
    await runGatedDeploy({ releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id: 'bad' } }, h.fx);
    expect(loadLedger(h.releasesDir).releases.find((r) => r.id === 'bad')?.healthy).toBe(false);
  });
});

describe('gate 2 — a build that boots then fails readiness auto-rolls-back', () => {
  it('flips back to the previous release and restarts again, with no human in the loop', async () => {
    const h = harness();
    await seedCurrent(h, 'good');
    h.restart.mockClear();
    h.events.length = 0;

    const out = await runGatedDeploy(
      { releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id: 'bad' } },
      { ...h.fx, probeReady: async () => ({ ok: false, detail: '/api/v1/ready 500' }) },
    );

    expect(out.ok).toBe(false);
    expect(out.failedAt).toBe('readiness');
    expect(out.rolledBackTo).toBe('good');
    // restarted twice: once for the doomed cutover, once to restore
    expect(h.restart).toHaveBeenCalledTimes(2);
    expect(currentTarget(h.linkPath)).toBe(releaseDir(h.releasesDir, 'good'));
    expect(loadLedger(h.releasesDir).current).toBe('good');
    expect(loadLedger(h.releasesDir).releases.find((r) => r.id === 'bad')?.healthy).toBe(false);
    expect(h.events.at(-1)).toMatchObject({ name: 'deploy.rollback', failedAt: 'readiness' });
  });

  it('with nothing to roll back to, reports the failure rather than flipping into the void', async () => {
    const h = harness({ probeReady: async () => ({ ok: false, detail: 'no' }) });
    const out = await runGatedDeploy({ releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id: 'first' } }, h.fx);
    expect(out.ok).toBe(false);
    expect(out.rolledBackTo).toBeUndefined();
    // the symlink still points at the only release there is — never dangling
    expect(currentTarget(h.linkPath)).toBe(releaseDir(h.releasesDir, 'first'));
  });
});

describe('pruning', () => {
  it('only prunes AFTER a release is proven healthy, never before the readiness gate', async () => {
    // Pruning on the way in could delete the very tree a failed readiness probe needs.
    const h = harness();
    await seedCurrent(h, 'r1');
    saveLedger(h.releasesDir, { ...loadLedger(h.releasesDir), keep: 1 });

    await runGatedDeploy(
      { releasesDir: h.releasesDir, linkPath: h.linkPath, entry: { id: 'r2' } },
      { ...h.fx, probeReady: async () => ({ ok: false, detail: 'bad' }) },
    );
    // r1 was the rollback target — it must still exist on disk
    expect(existsSync(releaseDir(h.releasesDir, 'r1'))).toBe(true);
    expect(currentTarget(h.linkPath)).toBe(releaseDir(h.releasesDir, 'r1'));
  });
});

describe('explicit rollback', () => {
  it('flips to the previous release and restarts', async () => {
    const h = harness();
    await seedCurrent(h, 'r1');
    await seedCurrent(h, 'r2');
    h.restart.mockClear();

    const out = await runRollback({ releasesDir: h.releasesDir, linkPath: h.linkPath }, h.fx);
    expect(out.ok).toBe(true);
    expect(out.rolledBackTo).toBe('r1');
    expect(currentTarget(h.linkPath)).toBe(releaseDir(h.releasesDir, 'r1'));
    expect(h.restart).toHaveBeenCalledOnce();
  });

  it('refuses when there is nothing to roll back to', async () => {
    const h = harness();
    await seedCurrent(h, 'only');
    const out = await runRollback({ releasesDir: h.releasesDir, linkPath: h.linkPath }, h.fx);
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/no previous release/);
  });
});
