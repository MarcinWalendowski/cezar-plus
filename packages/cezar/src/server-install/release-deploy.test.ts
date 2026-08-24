import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultHost, runReleaseDeploy, type ReleaseDeployHost } from './release-deploy.ts';
import { DETACHED_ENV } from './self-safe-deploy.ts';
import { loadLedger, saveLedger } from './releases.ts';
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
  let nowTick = 0;
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
      now: () => new Date(Date.parse('2026-08-21T09:00:00.000Z') + nowTick++ * 1_000).toISOString(),
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
    mkdirSync(join(source, 'packages/cezar/dist'), { recursive: true });
    mkdirSync(join(source, 'packages/cezar/src'), { recursive: true });
    writeFileSync(join(source, 'packages/cezar/package.json'), '{"version":"0.10.0"}\n');
    writeFileSync(join(source, 'packages/cezar/src/index.ts'), 'export {};\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: source });
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', 'source'], { cwd: source });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    writeFileSync(join(source, 'packages/cezar/dist/.build-stamp.json'), JSON.stringify({ stampVersion: 1, sha, builtAt: '2099-01-01T00:00:00.000Z', dirty: false, version: '0.10.0' }));
    return { linkPath, releasesDir, source };
  }

  /** A second real commit + matching build stamp, so a second deploy produces a genuinely
   *  distinct release id rather than tripping the `--sha` gate with a fabricated one. */
  function advanceSource(source: string, marker: string): void {
    writeFileSync(join(source, 'packages/cezar/src/index.ts'), `export const marker = '${marker}';\n`);
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-q', '-m', marker], { cwd: source });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    writeFileSync(
      join(source, 'packages/cezar/dist/.build-stamp.json'),
      JSON.stringify({ stampVersion: 1, sha, builtAt: '2099-01-01T00:00:00.000Z', dirty: false, version: '0.10.0' }),
    );
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
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
    const firstCurrent = loadLedger(box.releasesDir).current;
    expect(firstCurrent).toBeTruthy();

    const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);

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
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
    advanceSource(box.source, 'second');
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
    const rec = recorder({ waitReady: async () => ({ ok: false, detail: 'boom' }) });

    const result = await runReleaseDeploy({ ...box, env: {}, rollbackTo: '' }, rec.host);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.outcome?.failedAt).toBe('readiness');
    expect(rec.staged).toEqual([]);
  });

  it('restores and probes the pre-rollback release when the target is dead', async () => {
    const box = migratedBox();
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
    advanceSource(box.source, 'second');
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
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
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
    const first = loadLedger(box.releasesDir).current;
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
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

  it('a rollback dry run does not flip the symlink or restart — regression for the gap where --rollback --dry-run performed a real rollback', async () => {
    const box = migratedBox();
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
    const first = loadLedger(box.releasesDir).current;
    await runReleaseDeploy({ ...box, env: {} }, recorder().host);
    const second = loadLedger(box.releasesDir).current;
    expect(second).not.toBe(first);

    const rec = recorder();
    const result = await runReleaseDeploy({ ...box, env: {}, rollbackTo: '', dryRun: true }, rec.host);

    expect(result.ok).toBe(true);
    expect(rec.restarts).toBe(0);
    // The ledger's `current` is unchanged — the dry run never reached `runRollback`.
    expect(loadLedger(box.releasesDir).current).toBe(second);
  });

  it('a dry run inside the cgroup it would re-exec out of still prints the plan and reports no detached unit', async () => {
    // The gap found in review: the dry-run short-circuit used to live INSIDE the re-exec branch,
    // returning `detachedUnit: 'dry-run:<id>'` with no plan ever printed, which `releaseDeployCommand`
    // then reports as a real detached deploy. Moving the check to run right after `decideReExec`
    // logs its reason — but before `decision.reExec` is acted on — closes that gap for the
    // population (an agent-driven deploy on a not-yet-migrated box) this whole flag exists for.
    const box = migratedBox();
    const lines: string[] = [];
    const rec = recorder({
      systemdRunAvailable: () => true,
      cgroup: () => '0::/system.slice/cezar.service',
    });
    const result = await runReleaseDeploy({ ...box, env: {}, dryRun: true, log: (line) => lines.push(line) }, rec.host);

    expect(result.ok).toBe(true);
    expect(result.detachedUnit).toBeUndefined();
    expect(rec.detached).toEqual([]);
    expect(rec.staged).toEqual([]);
    expect(rec.restarts).toBe(0);
    expect(lines.some((l) => l.startsWith('deploy: '))).toBe(true);
    expect(lines.some((l) => l.startsWith('DRY RUN — would stage'))).toBe(true);
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

    it('emits `--rollback=`, never a bare `--rollback`, in the transient unit argv for an empty rollback (`.ai/specs/2026-08-23-bare-rollback-argv-trap.md`)', async () => {
      // Before the fix, `reExecCommand` pushed the literal bare `--rollback` token here, followed
      // unconditionally by `--release-id=…` — an argv the child's own `parseArgs` cannot accept
      // (`argument is ambiguous`), so the detached rollback died silently while the parent reported
      // `{ ok: true, detachedUnit }` and exited 0. This is the fail-OPEN half of the bug.
      const box = migratedBox();
      const rec = recorder({ killMode: () => 'control-group', cgroup: () => INSIDE, systemdRunAvailable: () => true });
      const result = await runReleaseDeploy({ ...box, env: {}, rollbackTo: '' }, rec.host);

      expect(result.detachedUnit).toBeTruthy();
      expect(rec.detached).toHaveLength(1);
      const argv = rec.detached[0] ?? [];
      expect(argv).toContain('--rollback=');
      expect(argv).not.toContain('--rollback');
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

  /**
   * A2 (the build-stamp gate) and B1 (the live-sha relation gate), spec
   * `.ai/specs/2026-08-22-live-worktree-reaped-mid-run.md`. Before this describe block neither gate
   * had a single test: the incident that motivated them (a stale `dist/` shipped under a fresh sha)
   * would have sailed through every pre-existing `it()` in this file, because `migratedBox()`'s
   * fixture stamp always agrees with source HEAD. Per that spec's Q9, a naive "the branch still
   * exists"-style assertion proves nothing here — these assert on the REFUSAL and on what the
   * ledger records, which is the only thing that would have caught `504ce87f`.
   */
  describe('artifact + ancestry gates (A2/B1, 2026-08-22)', () => {
    /** A real, resolvable-but-wrong sha: same shape as a real one, cannot possibly equal HEAD. */
    const WRONG_SHA = 'a'.repeat(40);
    const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

    /** A second worktree of `source`'s own repo, detached at `sha`, with its own dist + stamp —
     *  i.e. a second checkout that is genuinely BEHIND (or beside) `source`'s current HEAD, which
     *  `advanceSource` cannot produce because it only ever moves one tree forward. */
    function checkoutAt(source: string, sha: string, stampSha = sha): string {
      // `git worktree add` refuses a target path that already exists, even empty — so the leaf
      // itself must not be pre-created the way `scratch()`'s `mkdtemp` does.
      const dir = join(scratch(), 'wt');
      execFileSync('git', ['worktree', 'add', '-q', '--detach', dir, sha], { cwd: source });
      mkdirSync(join(dir, 'packages/cezar/dist'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/cezar/dist/.build-stamp.json'),
        JSON.stringify({ stampVersion: 1, sha: stampSha, builtAt: '2099-01-01T00:00:00.000Z', dirty: false, version: '0.10.0' }),
      );
      return dir;
    }

    /** A worktree that commits ONE MORE change on top of `sha`, independently of whatever `source`
     *  itself later did from that same point — the shape of two tasks branching off a shared base,
     *  which is what makes B1's divergent case (neither side is an ancestor of the other). */
    function divergeFrom(source: string, sha: string, marker: string): { dir: string; sha: string } {
      const dir = checkoutAt(source, sha);
      writeFileSync(join(dir, 'packages/cezar/src/index.ts'), `export const marker = '${marker}';\n`);
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', [...GIT_ID, 'commit', '-q', '-m', marker], { cwd: dir });
      const newSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      writeFileSync(
        join(dir, 'packages/cezar/dist/.build-stamp.json'),
        JSON.stringify({ stampVersion: 1, sha: newSha, builtAt: '2099-01-01T00:00:00.000Z', dirty: false, version: '0.10.0' }),
      );
      return { dir, sha: newSha };
    }

    function currentEntry(releasesDir: string) {
      const ledger = loadLedger(releasesDir);
      return ledger.releases.find((r) => r.id === ledger.current);
    }

    it('stamp sha disagreeing with source HEAD refuses and names both shas', async () => {
      const box = migratedBox();
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.source, encoding: 'utf8' }).trim();
      writeFileSync(
        join(box.source, 'packages/cezar/dist/.build-stamp.json'),
        JSON.stringify({ stampVersion: 1, sha: WRONG_SHA, builtAt: '2099-01-01T00:00:00.000Z', dirty: false, version: '0.10.0' }),
      );
      const rec = recorder();
      const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
      expect(result.ok).toBe(false);
      expect(result.error).toContain(WRONG_SHA);
      expect(result.error).toContain(headSha);
      expect(rec.staged).toEqual([]);
    });

    it('stamp sha equal to source HEAD proceeds — the control that proves the gate is not always-refuse', async () => {
      const box = migratedBox();
      const rec = recorder();
      const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
      expect(result.ok).toBe(true);
      expect(rec.staged).toHaveLength(1);
    });

    it('replays the incident: a dist stamp built before the commit it ships under is refused', async () => {
      // 20260822T131126Z-504ce87f: dist/ built 07:48:29Z, ten minutes before the commit at HEAD
      // (07:58:54Z) that the stamp claims to have been built from.
      const box = migratedBox();
      const staleStamp = readFileSync(join(box.source, 'packages/cezar/dist/.build-stamp.json'), 'utf8');
      advanceSource(box.source, 'fix-lands'); // moves HEAD forward and rewrites the stamp to match
      writeFileSync(join(box.source, 'packages/cezar/dist/.build-stamp.json'), staleStamp); // ...put the OLD one back
      const rec = recorder();
      const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('disagrees with source HEAD');
      expect(rec.staged).toEqual([]);
    });

    it('a missing stamp refuses, naming the command that fixes it', async () => {
      const box = migratedBox();
      rmSync(join(box.source, 'packages/cezar/dist/.build-stamp.json'));
      const rec = recorder();
      const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('run npm run build first');
      expect(rec.staged).toEqual([]);
    });

    it('a truncated/unparseable stamp refuses rather than assuming HEAD', async () => {
      const box = migratedBox();
      writeFileSync(join(box.source, 'packages/cezar/dist/.build-stamp.json'), '{"stampVersion":1,"sha":"a');
      const rec = recorder();
      const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('unreadable');
      expect(rec.staged).toEqual([]);
    });

    it("a tracked source file touched after the stamp's builtAt refuses; touched before it proceeds", async () => {
      const box = migratedBox();
      const stamp = JSON.parse(readFileSync(join(box.source, 'packages/cezar/dist/.build-stamp.json'), 'utf8')) as { builtAt: string };
      const builtAtMs = Date.parse(stamp.builtAt);
      const target = join(box.source, 'packages/cezar/src/index.ts');

      const after = new Date(builtAtMs + 5_000);
      utimesSync(target, after, after);
      const refused = await runReleaseDeploy({ ...box, env: {} }, recorder().host);
      expect(refused.ok).toBe(false);
      expect(refused.error).toContain('newer than the build stamp');

      const before = new Date(builtAtMs - 5_000);
      utimesSync(target, before, before);
      const proceeded = await runReleaseDeploy({ ...box, env: {} }, recorder().host);
      expect(proceeded.ok).toBe(true);
    });

    it('--allow-stale-artifact ships anyway, and the ledger records the STAMP sha/builtAt — not source HEAD or deploy time', async () => {
      const box = migratedBox();
      const stamp = JSON.parse(readFileSync(join(box.source, 'packages/cezar/dist/.build-stamp.json'), 'utf8')) as { sha: string; builtAt: string };
      advanceSource(box.source, 'after-build'); // moves HEAD (and rewrites the stamp) past what was "built"
      writeFileSync(join(box.source, 'packages/cezar/dist/.build-stamp.json'), JSON.stringify(stamp)); // restore the stale one
      const rec = recorder();
      const result = await runReleaseDeploy({ ...box, env: {}, allowStaleArtifact: true }, rec.host);
      expect(result.ok).toBe(true);
      const entry = currentEntry(box.releasesDir);
      expect(entry?.sha).toBe(stamp.sha);
      expect(entry?.builtAt).toBe(stamp.builtAt);
      expect(entry?.stale).toBe(true);
    });

    it('deploy.json absent is a first deploy — allowed', async () => {
      const box = migratedBox();
      expect(existsSync(join(box.releasesDir, 'deploy.json'))).toBe(false);
      const result = await runReleaseDeploy({ ...box, env: {} }, recorder().host);
      expect(result.ok).toBe(true);
    });

    it('deploy.json present but unparseable refuses — the fail-open trap loadLedger alone would wave through', async () => {
      const box = migratedBox();
      mkdirSync(box.releasesDir, { recursive: true });
      writeFileSync(join(box.releasesDir, 'deploy.json'), '{not json');
      const result = await runReleaseDeploy({ ...box, env: {} }, recorder().host);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('--allow-unrelated');
    });

    it('a ledger row whose sha is absent refuses forward activation (Q5: the dropped stamp-fallback path)', async () => {
      const box = migratedBox();
      await runReleaseDeploy({ ...box, env: {} }, recorder().host);
      const ledger = loadLedger(box.releasesDir);
      const id = ledger.current as string;
      saveLedger(box.releasesDir, {
        ...ledger,
        releases: ledger.releases.map((r) => (r.id === id ? { ...r, sha: undefined } : r)),
      });
      advanceSource(box.source, 'second');
      const result = await runReleaseDeploy({ ...box, env: {} }, recorder().host);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('--allow-unrelated');
    });

    describe("B1 — the five-valued relation to live, and it must tell 'behind' from 'sideways'", () => {
      it('equal: re-deploying the exact live sha proceeds (flips, restarts)', async () => {
        const box = migratedBox();
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        const rec = recorder();
        const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
        expect(result.ok).toBe(true);
        expect(rec.restarts).toBe(1);
      });

      it('descendant: a forward commit proceeds normally', async () => {
        const box = migratedBox();
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        advanceSource(box.source, 'forward');
        const rec = recorder();
        const result = await runReleaseDeploy({ ...box, env: {} }, rec.host);
        expect(result.ok).toBe(true);
        expect(rec.staged).toHaveLength(1);
      });

      it('strict ancestor of live: exits 0 as a no-op — no flip, no restart, no new ledger row, and never mentions --rollback', async () => {
        const box = migratedBox();
        const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.source, encoding: 'utf8' }).trim();
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        advanceSource(box.source, 'forward');
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        const before = loadLedger(box.releasesDir);

        const ancestorSource = checkoutAt(box.source, firstSha);
        const lines: string[] = [];
        const rec = recorder();
        const result = await runReleaseDeploy({ ...box, source: ancestorSource, releasesDir: box.releasesDir, linkPath: box.linkPath, env: {}, log: (l) => lines.push(l) }, rec.host);

        expect(result.ok).toBe(true);
        expect(rec.staged).toEqual([]);
        expect(rec.restarts).toBe(0);
        expect(loadLedger(box.releasesDir)).toEqual(before);
        expect(lines.some((l) => l.includes('already live'))).toBe(true);
        expect(lines.some((l) => l.includes('--rollback'))).toBe(false);
      });

      it('divergent from live: refused, names the live-only commits, and --allow-unrelated forces it through leaving a ledger trace', async () => {
        const box = migratedBox();
        const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.source, encoding: 'utf8' }).trim();
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        advanceSource(box.source, 'landed-on-live'); // this becomes the live sha
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        const liveSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: box.source, encoding: 'utf8' }).trim();

        const { dir: sideDir } = divergeFrom(box.source, baseSha, 'sideways-task');
        const readlinkBefore = existsSync(box.linkPath) ? readlinkSync(box.linkPath) : null;

        const refused = await runReleaseDeploy({ ...box, source: sideDir, releasesDir: box.releasesDir, linkPath: box.linkPath, env: {} }, recorder().host);
        expect(refused.ok).toBe(false);
        expect(refused.error).toContain('divergent');
        expect(refused.error).toContain(liveSha ?? '');
        // Review pass 7's defect 2: the refusal must name the LIVE SHA as the merge target, never
        // tell an agent to merge origin/main — merging origin/main cannot fix a divergence from a
        // live sha that never landed there (a `cez/<id8>` tip deployed directly).
        expect(refused.error).toContain(`merge the live sha ${liveSha}`);
        expect(readlinkSync(box.linkPath)).toBe(readlinkBefore);

        const rec = recorder();
        const forced = await runReleaseDeploy({ ...box, source: sideDir, releasesDir: box.releasesDir, linkPath: box.linkPath, env: {}, allowUnrelated: true }, rec.host);
        expect(forced.ok).toBe(true);
        const entry = currentEntry(box.releasesDir);
        expect(entry?.unrelated).toBe(true);
        expect(entry?.unrelatedLostCommits).toBeTruthy();
      });

      it('unresolvable live sha: refused, and --allow-unrelated forces it through recording unrelated with no commit list', async () => {
        const box = migratedBox();
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        const ledger = loadLedger(box.releasesDir);
        const id = ledger.current as string;
        saveLedger(box.releasesDir, {
          ...ledger,
          releases: ledger.releases.map((r) => (r.id === id ? { ...r, sha: WRONG_SHA } : r)),
        });
        advanceSource(box.source, 'second');

        const refused = await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        expect(refused.ok).toBe(false);
        expect(refused.error).toContain('--allow-unrelated');

        const rec = recorder();
        const forced = await runReleaseDeploy({ ...box, env: {}, allowUnrelated: true }, rec.host);
        expect(forced.ok).toBe(true);
        const entry = currentEntry(box.releasesDir);
        expect(entry?.unrelated).toBe(true);
        expect(entry?.unrelatedLostCommits).toBeFalsy();
      });

      it('--allow-unrelated passed on an ordinary forward deploy writes no trace at all — the field means "forced", not "flag typed"', async () => {
        const box = migratedBox();
        await runReleaseDeploy({ ...box, env: {} }, recorder().host);
        advanceSource(box.source, 'forward');
        const result = await runReleaseDeploy({ ...box, env: {}, allowUnrelated: true }, recorder().host);
        expect(result.ok).toBe(true);
        const entry = currentEntry(box.releasesDir);
        expect(entry?.unrelated).toBeUndefined();
        expect(entry?.unrelatedLostCommits).toBeUndefined();
      });
    });
  });
});
