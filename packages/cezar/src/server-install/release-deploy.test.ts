import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultHost, runReleaseDeploy, type ReleaseDeployHost } from './release-deploy.ts';
import { DETACHED_ENV } from './self-safe-deploy.ts';
import { loadLedger } from './releases.ts';
import type { ProbeResult } from './deploy-strategy.ts';

/**
 * `runReleaseDeploy` — the glue between the pure deploy orchestration and a real box (P1/P2/P5 of
 * `.ai/specs/2026-08-19-non-disruptive-cezar-self-deploy.md`).
 *
 * The orchestration's own branches are covered by `deploy-strategy.test.ts`. What is only testable
 * here is the part that decides whether the deploy is even allowed to start: does it get out of
 * the cgroup before touching anything, does it refuse an unmigrated install, and — the acceptance
 * criterion — does a failing build stop short of the flip.
 */
describe('runReleaseDeploy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'cez-reldeploy-'));
    dirs.push(dir);
    return dir;
  }

  interface Recorder {
    host: ReleaseDeployHost;
    staged: string[];
    restarts: number;
    probes: number;
    detached: string[][];
  }

  function recorder(overrides: Partial<ReleaseDeployHost> = {}): Recorder {
    const rec: Recorder = { staged: [], restarts: 0, probes: 0, detached: [], host: {} as ReleaseDeployHost };
    rec.host = {
      async stage(_source, target) {
        mkdirSync(target, { recursive: true });
        rec.staged.push(target);
      },
      // Default to the PRE-migration mode so every existing case keeps the behaviour it was
      // written for; the new cases override it to 'process'.
      killMode: () => 'control-group',
      async smokeBoot(): Promise<ProbeResult> {
        return { ok: true };
      },
      async restart() {
        rec.restarts += 1;
      },
      async probeReady(): Promise<ProbeResult> {
        return { ok: true };
      },
      async waitReady(): Promise<ProbeResult> {
        rec.probes += 1;
        return { ok: true };
      },
      freeBytes: () => Number.POSITIVE_INFINITY,
      now: () => '2026-08-21T09:00:00.000Z',
      spawnDetached: (argv) => rec.detached.push(argv),
      systemdRunAvailable: () => false,
      cgroup: () => '0::/user.slice/session-1.scope',
      ...overrides,
    };
    return rec;
  }

  /** A box where `/opt/cezar` is already the release symlink P1 creates. */
  function migratedBox(): { linkPath: string; releasesDir: string; source: string } {
    const root = scratch();
    const releasesDir = join(root, 'releases');
    const seed = join(releasesDir, '20260101T000000Z-old');
    mkdirSync(seed, { recursive: true });
    const linkPath = join(root, 'cezar');
    symlinkSync(seed, linkPath);
    const source = join(root, 'src');
    mkdirSync(source, { recursive: true });
    return { linkPath, releasesDir, source };
  }

  it('hands the deploy to a transient unit when it is inside the cgroup it is about to restart', async () => {
    const box = migratedBox();
    // The 2026-08-19 production failure, reproduced: the deploying session was pid 1441357 inside
    // `cezar.service`'s own cgroup, and `KillMode=control-group` SIGKILLed it mid-cutover.
    const rec = recorder({
      systemdRunAvailable: () => true,
      cgroup: () => '0::/system.slice/cezar.service',
    });
    const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);

    expect(result.ok).toBe(true);
    expect(result.detachedUnit).toBeTruthy();
    expect(rec.detached).toHaveLength(1);
    expect(rec.detached[0]?.[0]).toBe('systemd-run');
    // Nothing was staged, flipped or restarted by THIS process — it is only the launcher now.
    expect(rec.staged).toEqual([]);
    expect(rec.restarts).toBe(0);
  });

  it('does not re-exec once already detached — the recursion guard', async () => {
    const box = migratedBox();
    const rec = recorder({
      systemdRunAvailable: () => true,
      cgroup: () => '0::/system.slice/cezar.service',
    });
    // Without this guard each transient unit would fork another, each restarting the service.
    const result = await runReleaseDeploy({ ...box, env: { [DETACHED_ENV]: '1' } }, rec.host);

    expect(result.detachedUnit).toBeUndefined();
    expect(rec.detached).toEqual([]);
    expect(rec.staged).toHaveLength(1);
  });

  it('does not re-exec an operator who is already outside the cgroup', async () => {
    const box = migratedBox();
    const rec = recorder({ systemdRunAvailable: () => true });
    const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
    expect(result.detachedUnit).toBeUndefined();
    expect(rec.restarts).toBe(1);
  });

  it('a failing smoke boot never flips and never restarts', async () => {
    const box = migratedBox();
    const rec = recorder({ smokeBoot: async () => ({ ok: false, detail: 'candidate never became ready' }) });

    const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);

    expect(result.ok).toBe(false);
    expect(result.outcome?.failedAt).toBe('smoke_boot');
    // The acceptance criterion's (e): the running release is untouched. Not "rolled back" —
    // never moved.
    expect(rec.restarts).toBe(0);
    expect(loadLedger(box.releasesDir).current).toBeUndefined();
  });

  it('a build that boots and then fails readiness is rolled back without a human', async () => {
    const box = migratedBox();
    // Seed a `current` so there is somewhere to roll back TO.
    const rec = recorder({ probeReady: async () => ({ ok: false, detail: '/api/v1/ready answered 500' }) });
    await runReleaseDeploy({ ...box, env: {}, sha: 'aaaaaaa' }, recorder().host);
    const firstCurrent = loadLedger(box.releasesDir).current;
    expect(firstCurrent).toBeTruthy();

    const result = await runReleaseDeploy({ ...box, env: {}, sha: 'bbbbbbb' }, rec.host);

    expect(result.ok).toBe(false);
    expect(result.outcome?.failedAt).toBe('readiness');
    expect(result.outcome?.rolledBackTo).toBe(firstCurrent);
    // Flip, restart, flip back, restart: the rollback is subject to exactly the same gapless
    // machinery as the deploy, which is the point of expressing it as another flip.
    expect(rec.restarts).toBe(2);
    expect(loadLedger(box.releasesDir).current).toBe(firstCurrent);
  });

  it('refuses to flip when the install path is still a plain directory', async () => {
    const root = scratch();
    const linkPath = join(root, 'cezar');
    mkdirSync(linkPath, { recursive: true });
    writeFileSync(join(linkPath, 'package.json'), '{}');
    const rec = recorder();

    const result = await runReleaseDeploy(
      { source: join(root, 'src'), linkPath, releasesDir: join(root, 'releases'), env: {} },
      rec.host,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not a release symlink');
    expect(rec.staged).toEqual([]);
  });

  it('reports a failed rollback readiness probe without rebuilding', async () => {
    const box = migratedBox();
    await runReleaseDeploy({ ...box, env: {}, sha: 'aaaaaaa' }, recorder().host);
    await runReleaseDeploy({ ...box, env: {}, sha: 'bbbbbbb' }, recorder().host);
    const rec = recorder({ waitReady: async () => ({ ok: false, detail: 'boom' }) });

    const result = await runReleaseDeploy({ ...box, env: {}, rollbackTo: '' }, rec.host);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.outcome?.failedAt).toBe('readiness');
    expect(rec.staged).toEqual([]);
  });

  it('restores and probes the pre-rollback release when the target is dead', async () => {
    const box = migratedBox();
    await runReleaseDeploy({ ...box, env: {}, sha: 'aaaaaaa' }, recorder().host);
    await runReleaseDeploy({ ...box, env: {}, sha: 'bbbbbbb' }, recorder().host);
    const before = loadLedger(box.releasesDir).current;
    let probes = 0;
    const rec = recorder({
      waitReady: async () => (++probes === 1 ? { ok: false, detail: 'dead target' } : { ok: true }),
    });

    const result = await runReleaseDeploy({ ...box, env: {}, rollbackTo: '' }, rec.host);

    expect(result.ok).toBe(false);
    expect(rec.restarts).toBe(2);
    expect(loadLedger(box.releasesDir).current).toBe(before);
    expect(result.outcome?.serving).toEqual({ releaseId: before, ready: true });
  });

  it('refuses to stage when the disk is nearly full, before touching anything', async () => {
    const box = migratedBox();
    const rec = recorder({ freeBytes: () => 100 * 1024 * 1024 });
    const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing to stage');
    expect(rec.staged).toEqual([]);
  });

  it('rolls back to the previous release on request, with one restart', async () => {
    const box = migratedBox();
    await runReleaseDeploy({ ...box, env: {}, sha: 'aaaaaaa' }, recorder().host);
    const first = loadLedger(box.releasesDir).current;
    await runReleaseDeploy({ ...box, env: {}, sha: 'bbbbbbb' }, recorder().host);
    expect(loadLedger(box.releasesDir).current).not.toBe(first);

    const rec = recorder();
    const result = await runReleaseDeploy({ ...box, env: {}, rollbackTo: '' }, rec.host);

    expect(result.ok).toBe(true);
    expect(loadLedger(box.releasesDir).current).toBe(first);
    expect(rec.restarts).toBe(1);
    expect(rec.probes).toBe(1);
    // A rollback rebuilds nothing — it is a symlink rename, which is what makes it seconds.
    expect(rec.staged).toEqual([]);
  });

  it('a dry run changes nothing', async () => {
    const box = migratedBox();
    const rec = recorder();
    const result = await runReleaseDeploy({ ...box, env: {}, dryRun: true }, rec.host);
    expect(result.ok).toBe(true);
    expect(rec.staged).toEqual([]);
    expect(rec.restarts).toBe(0);
  });

  describe('agent-task deploy on a migrated box (2026-08-21)', () => {
    /**
     * The gap this closes, measured on prod-host: an operator over ssh was always fine
     * (`decideReExec` returns false — not inside the cgroup), but a deploy driven from INSIDE an
     * agent task IS inside cezar.service's cgroup, took the re-exec branch, and died on
     * "Access denied ... requires interactive authentication" because it asked for a SYSTEM
     * transient unit. Granting that right would have been root-equivalent under a narrow name.
     */
    const INSIDE = '0::/system.slice/cezar.service';

    it('does NOT hand off to a transient unit once the unit stops with KillMode=process', async () => {
      const box = migratedBox();
      const rec = recorder({ killMode: () => 'process', cgroup: () => INSIDE, systemdRunAvailable: () => true });
      const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);

      expect(result.detachedUnit).toBeUndefined();
      expect(rec.detached).toEqual([]);
      // and it actually deployed rather than bailing out
      expect(rec.restarts).toBeGreaterThan(0);
    });

    it('still hands off when the restart would take the whole cgroup down', async () => {
      const box = migratedBox();
      const rec = recorder({ killMode: () => 'control-group', cgroup: () => INSIDE, systemdRunAvailable: () => true });
      const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);

      expect(result.detachedUnit).toBeTruthy();
      expect(rec.detached).toHaveLength(1);
    });

    it('asks the USER manager for the transient unit, never the system one, as a non-root uid', async () => {
      const box = migratedBox();
      const rec = recorder({ killMode: () => 'control-group', cgroup: () => INSIDE, systemdRunAvailable: () => true });
      await runReleaseDeploy({ ...box, env: {} }, rec.host);

      const argv = rec.detached[0] ?? [];
      expect(argv[0]).toBe('systemd-run');
      // Vitest does not run as root, so this exercises the real branch.
      if ((process.getuid?.() ?? 0) !== 0) expect(argv).toContain('--user');
    });
  });

  describe('defaultHost(log).stage — the real rsync, not a mock (2026-08-22)', () => {
    /**
     * Every case above supplies a mocked `stage`, so none of them ever run the actual rsync — which
     * is exactly why the exclude list could ship missing `.ai/cezar/worktrees` and `.ai/cezar/tmp`
     * uncaught. This exercises `defaultHost`'s real implementation directly against a seeded source
     * tree, pinning what it does and does not copy.
     */
    it('excludes .git, .ai/cezar/runs, .ai/cezar/worktrees and .ai/cezar/tmp, but keeps tracked files', async () => {
      const source = scratch();
      const target = scratch();
      writeFileSync(join(source, 'package.json'), '{}');
      mkdirSync(join(source, '.git'), { recursive: true });
      writeFileSync(join(source, '.git', 'HEAD'), 'ref: refs/heads/main');
      mkdirSync(join(source, '.ai/cezar/runs/some-run'), { recursive: true });
      writeFileSync(join(source, '.ai/cezar/runs/some-run/marker'), 'x');
      mkdirSync(join(source, '.ai/cezar/worktrees/some-task/node_modules'), { recursive: true });
      writeFileSync(join(source, '.ai/cezar/worktrees/some-task/node_modules/marker'), 'x');
      mkdirSync(join(source, '.ai/cezar/tmp/some-run'), { recursive: true });
      writeFileSync(join(source, '.ai/cezar/tmp/some-run/marker'), 'x');

      const host = defaultHost(() => {});
      await host.stage(source, target);

      expect(existsSync(join(target, 'package.json'))).toBe(true);
      expect(existsSync(join(target, '.git', 'HEAD'))).toBe(false);
      expect(existsSync(join(target, '.ai/cezar/runs'))).toBe(false);
      expect(existsSync(join(target, '.ai/cezar/worktrees'))).toBe(false);
      expect(existsSync(join(target, '.ai/cezar/tmp'))).toBe(false);
    });
  });
});
