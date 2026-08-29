import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recheckManualDeployParksEverywhere, type ParkSweepManager } from './recheck-parks-workspace.ts';

/**
 * The sweep has to reach the project that actually parks.
 *
 * MEASURED 2026-08-29 on prod-host. `serveCommand` swept `manager` — the BOOT project's
 * manager — and nothing else. That box's boot project is `workspace`
 * (`WorkingDirectory=/var/lib/cezar/workspace`, health reports `bootProject: "workspace"`), while
 * every cezar deploy park lives in the separately-registered `cezar` project. The sweep therefore
 * ran on a project that never parks and never looked at the one that does. Two runs stayed
 * `waiting` on `manual-deploy` across an activation that satisfied both — verified by running each
 * run's own probe by hand in its worktree afterwards, where it exited 0.
 *
 * The old shape passes every existing test in `recover-manual-deploy.test.ts`, because those drive
 * `recheckManualDeployParks()` on a manager DIRECTLY. Nothing covered which managers the boot path
 * chooses to call it on, which is where the whole feature was lost.
 */
describe('the post-restart manual-deploy sweep, across a multi-project workspace', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cez-sweep-workspace-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A project root whose `runs.json` does or does not hold a manual-deploy park. */
  const project = (name: string, opts: { parked: boolean; runsJson?: string }): { id: string; root: string } => {
    const root = join(dir, name);
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    const body =
      opts.runsJson ??
      JSON.stringify(
        opts.parked
          ? [{ id: 'r1', status: 'waiting', pendingHandoff: { kind: 'manual-deploy', stepId: 'deploy' } }]
          : [{ id: 'r1', status: 'done' }],
      );
    writeFileSync(join(root, '.ai/cezar/runs.json'), body);
    return { id: `${name}-id`, root };
  };

  const manager = (requeues: number): ParkSweepManager => ({
    recheckManualDeployParks: vi.fn(async () => requeues),
  });

  it('sweeps a NON-boot project that has a park — the case production actually had', async () => {
    const boot = manager(0); // the boot project never parks, exactly like `workspace`
    const cezarManager = manager(2);
    const cezar = project('cezar', { parked: true });

    const requeued = await recheckManualDeployParksEverywhere({
      bootManager: boot,
      bootRoot: join(dir, 'workspace-boot'),
      contexts: { context: async () => ({ manager: cezarManager }) },
      listProjects: async () => [cezar],
    });

    expect(requeued).toBe(2);
    expect(cezarManager.recheckManualDeployParks).toHaveBeenCalledTimes(1);
    // The old code called ONLY this one and returned 0.
    expect(boot.recheckManualDeployParks).toHaveBeenCalledTimes(1);
  });

  it('does NOT open a project with no park — laziness is the constraint, not a nicety', async () => {
    // Building a context opens a RunStore and starts sweeps, which is the cost lazy watchers
    // exist to avoid. Without this, "sweep everything" would silently open every registered
    // project on every restart and the first test above would still pass.
    const context = vi.fn(async () => ({ manager: manager(1) }));

    const requeued = await recheckManualDeployParksEverywhere({
      bootManager: manager(0),
      bootRoot: join(dir, 'boot'),
      contexts: { context },
      listProjects: async () => [project('quiet', { parked: false }), project('also-quiet', { parked: false })],
    });

    expect(requeued).toBe(0);
    expect(context).not.toHaveBeenCalled();
  });

  it('never sweeps the boot project twice, however the registry spells its root', async () => {
    // The boot root is reachable through the registry too, and the context resolver short-circuits
    // to the boot manager — so without the skip this double-COUNTS rather than double-works, and
    // the console line would tell the operator a number that is not true.
    const bootRoot = join(dir, 'boot');
    mkdirSync(join(bootRoot, '.ai/cezar'), { recursive: true });
    writeFileSync(
      join(bootRoot, '.ai/cezar/runs.json'),
      JSON.stringify([{ id: 'r1', status: 'waiting', pendingHandoff: { kind: 'manual-deploy' } }]),
    );
    const context = vi.fn(async () => ({ manager: manager(3) }));

    const requeued = await recheckManualDeployParksEverywhere({
      bootManager: manager(3),
      bootRoot,
      contexts: { context },
      // Same root, trailing separator — the registry stores a normalized root, a boot root arrives
      // as whatever the caller passed.
      listProjects: async () => [{ id: 'boot-row', root: `${bootRoot}/` }],
    });

    expect(requeued).toBe(3);
    expect(context).not.toHaveBeenCalled();
  });

  it('one broken project costs only itself', async () => {
    const healthyManager = manager(1);
    const context = vi.fn(async (id: string) => {
      if (id === 'broken-id') throw new Error('cannot build this context');
      return { manager: healthyManager };
    });

    const requeued = await recheckManualDeployParksEverywhere({
      bootManager: manager(0),
      bootRoot: join(dir, 'boot'),
      contexts: { context },
      listProjects: async () => [project('broken', { parked: true }), project('healthy', { parked: true })],
    });

    // The project after the throwing one still got swept.
    expect(requeued).toBe(1);
    expect(healthyManager.recheckManualDeployParks).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed runs.json as "no park" rather than throwing the sweep away', async () => {
    const context = vi.fn(async () => ({ manager: manager(1) }));

    const requeued = await recheckManualDeployParksEverywhere({
      bootManager: manager(0),
      bootRoot: join(dir, 'boot'),
      contexts: { context },
      listProjects: async () => [project('garbage', { parked: false, runsJson: '{ not json' })],
    });

    expect(requeued).toBe(0);
    expect(context).not.toHaveBeenCalled();
  });

  it('falls back to the boot project alone when there is no context resolver', async () => {
    const boot = manager(4);
    const requeued = await recheckManualDeployParksEverywhere({
      bootManager: boot,
      bootRoot: join(dir, 'boot'),
      listProjects: async () => [project('cezar', { parked: true })],
    });
    expect(requeued).toBe(4);
  });
});
