import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { workspaceConfigPath, workspaceUiStatePath } from '../paths.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type WorkspaceConfigResponse } from './server.ts';

/**
 * The workspace settings API (multi-project spec, step 2.7):
 * `GET/PUT /api/v1/workspace/config` — the settings slice of `~/.cezar/config.json`
 * with the `projectsDir` writability probe and the semaphore `refresh()` hook —
 * and `GET/PUT /api/v1/workspace/ui-state`, the global GUI state with the same
 * merge/key-cap semantics as the per-repo ui-state route. All workspace-level:
 * single-mount, never under `/api/v1/p/`.
 */
describe('the workspace settings API (step 2.7)', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedBrowseRoot = process.env.CEZ_BROWSE_ROOT;
  const savedProjectsDir = process.env.CEZ_PROJECTS_DIR;
  const savedAutonomousDefault = process.env.CEZ_AUTONOMOUS_DEFAULT;
  const savedWorktreeDefault = process.env.CEZ_WORKTREE_DEFAULT;
  let home: string;
  let repoRoot: string;
  let store: RunStore;
  let semaphore: WorkspaceSemaphore;
  let app: Hono;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-workspace-api-'));
    process.env.CEZ_HOME = home; // paths.ts sends all workspace paths here
    delete process.env.CEZ_BROWSE_ROOT;
    delete process.env.CEZ_PROJECTS_DIR;
    delete process.env.CEZ_AUTONOMOUS_DEFAULT;
    delete process.env.CEZ_WORKTREE_DEFAULT;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-workspace-api-repo-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // The REAL semaphore with its production loader (which reads the CEZ_HOME
    // config), so the PUT → refresh() → cached-limits chain is observed end to
    // end. The routes never touch the manager — an empty stub is honest.
    semaphore = new WorkspaceSemaphore();
    app = createApp({
      repoRoot,
      store,
      manager: {} as RunManager,
      version: '0.0.0-test',
      semaphore,
    });
  });

  afterEach(() => {
    store.flush();
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedBrowseRoot === undefined) delete process.env.CEZ_BROWSE_ROOT;
    else process.env.CEZ_BROWSE_ROOT = savedBrowseRoot;
    if (savedProjectsDir === undefined) delete process.env.CEZ_PROJECTS_DIR;
    else process.env.CEZ_PROJECTS_DIR = savedProjectsDir;
    if (savedAutonomousDefault === undefined) delete process.env.CEZ_AUTONOMOUS_DEFAULT;
    else process.env.CEZ_AUTONOMOUS_DEFAULT = savedAutonomousDefault;
    if (savedWorktreeDefault === undefined) delete process.env.CEZ_WORKTREE_DEFAULT;
    else process.env.CEZ_WORKTREE_DEFAULT = savedWorktreeDefault;
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
  });

  const rawConfig = () => JSON.parse(readFileSync(workspaceConfigPath(), 'utf8')) as Record<string, unknown>;

  const getConfig = () => apiRequest(app, '/api/v1/workspace/config');
  const putConfig = (body: unknown) =>
    apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ---- GET/PUT /api/v1/workspace/config ---------------------------------------

  it('GET answers the zero-config defaults when no file exists — and never the registry', async () => {
    const res = await getConfig();
    expect(res.status).toBe(200);
    const body = (await res.json()) as WorkspaceConfigResponse & Record<string, unknown>;
    expect(body).toEqual({
      browseRoot: '~/',
      projectsDir: '~/cezar/projects',
      composerDefaults: {
        autonomous: null,
        worktree: null,
        inheritedAutonomous: 'source-dependent',
        inheritedWorktree: true,
      },
      resources: {
        maxParallel: 2,
        maxMonitoringSessions: 2,
        monitoringWakeIntervalMinutes: 5,
        autoResumeOnUsageLimit: true,
        fallbackAcrossAccountsWhenLimited: true,
        memoryLimitMb: null,
        worktreeRetentionDefault: 1000,
      },
      // Machine-wide agent defaults (spec 2026-07-29-agent-profiles). EMPTY, not populated: absent
      // keys mean "this machine has no opinion", which is what makes them defaults a repo can be
      // silent about rather than settings every checkout inherits a value from.
      agentDefaults: {},
      // The machine tier for the four per-repo run knobs
      // (`.ai/specs/2026-08-21-one-settings-area.md`). ALWAYS present with `null` for absent —
      // the `composerDefaults` convention, not `agentDefaults`' optional-key one — because a UI
      // has to tell "the machine says nothing" from "the machine says false".
      projectDefaults: { systemPrompt: null, liveTitleUpdates: null, reviewGate: null, stepBudget: null },
      // The global provider lock (`.ai/specs/2026-08-29-global-provider-toggle.md`). `null` = Auto,
      // ALWAYS present on the wire, same convention as `projectDefaults`.
      runnerLock: null,
    });
    // Absolute project roots belong on /api/v1/projects; schemaVersion is a
    // migration cursor, not a setting.
    expect(body.projects).toBeUndefined();
    expect(body.schemaVersion).toBeUndefined();
  });

  it('GET resolves both zero-config roots from the environment', async () => {
    process.env.CEZ_BROWSE_ROOT = '~/source';
    process.env.CEZ_PROJECTS_DIR = '~/clones';
    const body = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(body).toMatchObject({ browseRoot: '~/source', projectsDir: '~/clones' });
  });

  it('PUT resources round-trips, persists to disk, and refreshes the semaphore cache', async () => {
    expect(semaphore.maxParallel()).toBe(2); // the pre-PUT snapshot
    const res = await putConfig({
      resources: {
        maxParallel: 5,
        maxMonitoringSessions: 3,
        monitoringWakeIntervalMinutes: 5,
        autoResumeOnUsageLimit: false,
        memoryLimitMb: 2048,
      },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as WorkspaceConfigResponse).toEqual({
      browseRoot: '~/',
      projectsDir: '~/cezar/projects',
      composerDefaults: {
        autonomous: null,
        worktree: null,
        inheritedAutonomous: 'source-dependent',
        inheritedWorktree: true,
      },
      resources: {
        maxParallel: 5,
        maxMonitoringSessions: 3,
        monitoringWakeIntervalMinutes: 5,
        autoResumeOnUsageLimit: false,
        fallbackAcrossAccountsWhenLimited: true,
        memoryLimitMb: 2048,
        worktreeRetentionDefault: 1000,
      },
      // Untouched by a resources write, and still empty — the two live in the same file but answer
      // unrelated questions, so one must never materialize the other.
      agentDefaults: {},
      projectDefaults: { systemPrompt: null, liveTitleUpdates: null, reviewGate: null, stepBudget: null },
      runnerLock: null,
    });
    // Round-trip through GET and the raw file.
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).resources.maxParallel).toBe(5);
    expect((rawConfig().resources as Record<string, unknown>).maxParallel).toBe(5);
    // The step-2.5 hook fired: the new cap applies WITHOUT a restart.
    expect(semaphore.maxParallel()).toBe(5);
    expect(semaphore.maxMonitoringSessions()).toBe(3);
    expect(semaphore.monitoringWakeIntervalMinutes()).toBe(5);
    // Default-ON, so the write worth pinning is the one that turns it OFF (spec
    // 2026-08-03-auto-resume-after-usage-limit) — and it reaches the shared cache the engine
    // asks, not just the file.
    expect(semaphore.autoResumeOnUsageLimit()).toBe(false);
    expect(semaphore.memoryLimitMb()).toBe(2048);
  });

  /**
   * The out-of-quota fallback ships ON (spec `2026-08-23-never-block-a-task.md` — it was
   * default-OFF for one morning), so the write worth pinning is the one that turns it OFF, and it
   * has to survive all four threading points, not just the schema: the contract's PUT input,
   * `config.ts`'s parse, the GET response, and `WorkspaceSemaphore`. A key wired into three of
   * those and missed in the fourth fails silently, as a switch the settings screen shows and the
   * engine never reads.
   *
   * Turning it OFF is also the harder direction for a default-ON boolean, and the one a naive
   * merge gets wrong: `false` is falsy, so any `??`/`||` on the write path swallows it and the
   * setting appears to be stuck on.
   */
  it('PUT turns the out-of-quota fallback off, and it reaches the semaphore the engine asks', async () => {
    expect(semaphore.fallbackAcrossAccountsWhenLimited()).toBe(true); // the shipped default
    const res = await putConfig({ resources: { fallbackAcrossAccountsWhenLimited: false } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).resources.fallbackAcrossAccountsWhenLimited).toBe(false);
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).resources.fallbackAcrossAccountsWhenLimited).toBe(false);
    expect((rawConfig().resources as Record<string, unknown>).fallbackAcrossAccountsWhenLimited).toBe(false);
    expect(semaphore.fallbackAcrossAccountsWhenLimited()).toBe(false);
    // A partial write of an unrelated key must not drag it back to the default.
    await putConfig({ resources: { maxParallel: 4 } });
    expect(semaphore.fallbackAcrossAccountsWhenLimited()).toBe(false);
    // And back on again, so the assertion above cannot be passing because nothing writes at all.
    await putConfig({ resources: { fallbackAcrossAccountsWhenLimited: true } });
    expect(semaphore.fallbackAcrossAccountsWhenLimited()).toBe(true);
  });

  /** #810 — the cadence now ships ON, so the write worth pinning is the one that turns it
   *  OFF. `null` must survive the round-trip and reach the semaphore as `null`; re-defaulting
   *  it to 5 would silently overrule an operator who chose "Park until resumed". */
  it('PUT null parks monitoring and is never re-defaulted back to the shipped cadence', async () => {
    expect(semaphore.monitoringWakeIntervalMinutes()).toBe(5); // the zero-config default
    const res = await putConfig({ resources: { monitoringWakeIntervalMinutes: null } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).resources.monitoringWakeIntervalMinutes).toBeNull();
    expect(
      ((await (await getConfig()).json()) as WorkspaceConfigResponse).resources.monitoringWakeIntervalMinutes,
    ).toBeNull();
    expect((rawConfig().resources as Record<string, unknown>).monitoringWakeIntervalMinutes).toBeNull();
    expect(semaphore.monitoringWakeIntervalMinutes()).toBeNull();
  });

  /**
   * The machine tier (`.ai/specs/2026-08-21-one-settings-area.md`, Phase 3): `projectDefaults`.
   *
   * What is pinned is the delete convention and the round trip, because those are what the one
   * Settings area depends on — *All projects* has to be able to say "no opinion" again after
   * saying something, and an absent key is the only spelling of that in the file.
   */
  it('PUT projectDefaults round-trips through GET and the raw file', async () => {
    const res = await putConfig({
      projectDefaults: { systemPrompt: 'be brief', reviewGate: true, stepBudget: 12 },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).projectDefaults).toEqual({
      systemPrompt: 'be brief',
      liveTitleUpdates: null,
      reviewGate: true,
      stepBudget: 12,
    });
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).projectDefaults).toEqual({
      systemPrompt: 'be brief',
      liveTitleUpdates: null,
      reviewGate: true,
      stepBudget: 12,
    });
    // Absent in the FILE, not written as null: `~/.cezar/config.json` stays a file you can cat and
    // fix by hand (BACKWARD_COMPATIBILITY.md §3), and a key that says nothing should not be there.
    expect(rawConfig().projectDefaults).toEqual({
      systemPrompt: 'be brief',
      reviewGate: true,
      stepBudget: 12,
    });
  });

  it('null CLEARS a projectDefaults key back to "no opinion"; "" clears the prompt', async () => {
    await putConfig({ projectDefaults: { systemPrompt: 'be brief', reviewGate: false } });
    // `false` first, so the clear below is proved to remove the KEY rather than to write `false`.
    expect((rawConfig().projectDefaults as Record<string, unknown>).reviewGate).toBe(false);

    await putConfig({ projectDefaults: { reviewGate: null, systemPrompt: '' } });
    expect(rawConfig().projectDefaults).toEqual({});
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).projectDefaults).toEqual({
      systemPrompt: null,
      liveTitleUpdates: null,
      reviewGate: null,
      stepBudget: null,
    });
  });

  it('an unknown sibling key inside projectDefaults survives the write (.passthrough)', async () => {
    writeFileSync(
      workspaceConfigPath(),
      JSON.stringify({ projectDefaults: { fromANewerCezar: 'keep me' } }),
      'utf8',
    );
    await putConfig({ projectDefaults: { reviewGate: true } });
    expect(rawConfig().projectDefaults).toEqual({ fromANewerCezar: 'keep me', reviewGate: true });
  });

  it('a rejected browseRoot persists NOTHING, projectDefaults included', async () => {
    // The all-or-nothing contract this route has always had, extended to the new key rather than
    // quietly exempting it.
    const res = await putConfig({
      browseRoot: '/definitely/not/here',
      projectDefaults: { reviewGate: true },
    });
    expect(res.status).toBe(400);
    // Nothing persisted at all — the file is not even created, which is the strongest form of
    // "NOTHING". A later successful write is what brings it into existence.
    expect(existsSync(workspaceConfigPath())).toBe(false);
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).projectDefaults.reviewGate).toBeNull();
  });

  it('partial updates leave the other keys untouched', async () => {
    await putConfig({ resources: { maxParallel: 5 } });
    await putConfig({ resources: { worktreeRetentionDefault: 3 } });
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).resources).toEqual({
      maxParallel: 5,
      maxMonitoringSessions: 2,
      monitoringWakeIntervalMinutes: 5,
      autoResumeOnUsageLimit: true,
      fallbackAcrossAccountsWhenLimited: true,
      memoryLimitMb: null,
      worktreeRetentionDefault: 3,
    });
  });

  it('PUT stores and independently clears composer defaults while exposing env inheritance', async () => {
    process.env.CEZ_AUTONOMOUS_DEFAULT = '1';
    process.env.CEZ_WORKTREE_DEFAULT = '0';
    const inherited = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(inherited.composerDefaults).toEqual({
      autonomous: null,
      worktree: null,
      inheritedAutonomous: true,
      inheritedWorktree: false,
    });

    const explicit = (await (await putConfig({
      composerDefaults: { autonomous: false, worktree: true },
    })).json()) as WorkspaceConfigResponse;
    expect(explicit.composerDefaults).toMatchObject({ autonomous: false, worktree: true });
    expect(rawConfig().composerDefaults).toMatchObject({ autonomous: false, worktree: true });

    await putConfig({ composerDefaults: { worktree: null } });
    expect(rawConfig().composerDefaults).toEqual({ autonomous: false });
  });

  it('rejects an invalid browseRoot without writing', async () => {
    expect((await putConfig({ browseRoot: 42 })).status).toBe(400);
    expect(() => readFileSync(workspaceConfigPath(), 'utf8')).toThrow();
  });

  it('rejects out-of-bounds resources with 400 and writes nothing', async () => {
    for (const resources of [{ maxParallel: 0 }, { maxParallel: 17 }, { memoryLimitMb: -1 }]) {
      const res = await putConfig({ resources });
      expect(res.status, JSON.stringify(resources)).toBe(400);
      expect((await res.json()) as { error: string }).toHaveProperty('error');
    }
    expect(() => readFileSync(workspaceConfigPath(), 'utf8')).toThrow(); // never created
    expect(semaphore.maxParallel()).toBe(2);
  });

  it('a merge-written PUT never clobbers the registry or unknown keys (passthrough)', async () => {
    writeFileSync(
      workspaceConfigPath(),
      JSON.stringify({
        projects: [{ id: 'cezar', root: '/tmp/projects/cezar' }],
        futureKey: true,
      }),
      'utf8',
    );
    await putConfig({ resources: { maxParallel: 4 } });
    const raw = rawConfig();
    // The merge-write materializes the entry's schema defaults (name, dates…) —
    // what matters is the registration itself survives a settings PUT.
    expect(raw.projects).toMatchObject([{ id: 'cezar', root: '/tmp/projects/cezar' }]);
    expect(raw.futureKey).toBe(true);
    expect((raw.resources as Record<string, unknown>).maxParallel).toBe(4);
  });

  it('PUT projectsDir creates the directory, probes it, and stores the path as written', async () => {
    const dir = join(home, 'checkouts');
    const res = await putConfig({ projectsDir: dir });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).projectsDir).toBe(dir);
    expect(rawConfig().projectsDir).toBe(dir);
    // mkdir -p happened; the probe file was cleaned up.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('PUT browseRoot accepts and persists an existing independent browse directory', async () => {
    const browseRoot = join(home, 'source', 'repos');
    mkdirSync(browseRoot, { recursive: true });
    const res = await putConfig({ browseRoot });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).browseRoot).toBe(browseRoot);
    expect(rawConfig().browseRoot).toBe(browseRoot);
    expect(readdirSync(browseRoot)).toEqual([]);
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).projectsDir).toBe(
      '~/cezar/projects',
    );
  });

  it('PUT browseRoot warns for a missing directory without creating or persisting it', async () => {
    const existing = join(home, 'existing-source');
    mkdirSync(existing);
    expect((await putConfig({ browseRoot: existing })).status).toBe(200);

    const missing = join(home, 'missing', 'source');
    const res = await putConfig({ browseRoot: missing });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({
      error: `browse folder does not exist: ${missing}`,
    });
    expect(existsSync(missing)).toBe(false);
    expect(rawConfig().browseRoot).toBe(existing);
  });

  it('an unwritable projectsDir answers 400 "not writable: …" and persists NO change', async () => {
    await putConfig({ projectsDir: join(home, 'checkouts') }); // a known-good value first
    // A path under a regular file can never be created — fails on every
    // platform and uid (unlike a chmod 0500 dir, which root would ignore).
    writeFileSync(join(home, 'blocker'), 'not a directory', 'utf8');
    const res = await putConfig({ projectsDir: join(home, 'blocker', 'sub') });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toMatch(/^not writable: /);
    // The config on disk still holds the previous value.
    expect(rawConfig().projectsDir).toBe(join(home, 'checkouts'));
  });

  it('a relative projectsDir is refused before any probe touches the filesystem', async () => {
    const res = await putConfig({ projectsDir: 'relative/path' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^not writable: /);
  });

  it('a relative browseRoot is refused before any probe touches the filesystem', async () => {
    const res = await putConfig({ browseRoot: 'relative/path' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^not writable: /);
  });

  it('a malformed body answers 400 {error}', async () => {
    const res = await apiRequest(app, '/api/v1/workspace/config', {
      method: 'PUT',
      body: 'nonsense',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  // ---- the global provider lock (`.ai/specs/2026-08-29-global-provider-toggle.md`, V4) --------

  const putProviderEnabled = (provider: string, enabled: boolean) =>
    apiRequest(app, `/api/v1/providers/${provider}/enabled`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });

  it('PUT sets the lock, GET reflects it, and the semaphore accessor moves without a restart', async () => {
    const res = await putConfig({ runnerLock: 'claude' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).runnerLock).toBe('claude');
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).runnerLock).toBe('claude');
    expect(semaphore.runnerLock()).toBe('claude');
  });

  it('PUT { runnerLock: null } clears the lock back to Auto', async () => {
    await putConfig({ runnerLock: 'codex' });
    const res = await putConfig({ runnerLock: null });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WorkspaceConfigResponse).runnerLock).toBeNull();
    expect(semaphore.runnerLock()).toBeUndefined();
  });

  it('a PUT omitting runnerLock leaves it untouched (partial-patch rule)', async () => {
    await putConfig({ runnerLock: 'claude' });
    await putConfig({ resources: { maxParallel: 4 } });
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).runnerLock).toBe('claude');
  });

  it('rejects locking to a disabled provider with 400, persisting nothing', async () => {
    await putProviderEnabled('codex', false);
    const before = rawConfig();
    const res = await putConfig({ runnerLock: 'codex' });
    expect(res.status).toBe(400);
    expect(rawConfig()).toEqual(before);
    expect(semaphore.runnerLock()).toBeUndefined();
  });

  it('rejects a lock naming a non-lockable provider with 400 from the schema', async () => {
    for (const bad of ['pi', 'opencode']) {
      const res = await putConfig({ runnerLock: bad });
      expect(res.status, bad).toBe(400);
    }
    expect(() => readFileSync(workspaceConfigPath(), 'utf8')).toThrow(); // never created
  });

  it('a garbage runnerLock on disk degrades to no lock, and every other key survives', async () => {
    writeFileSync(
      workspaceConfigPath(),
      JSON.stringify({ browseRoot: '~/kept', runnerLock: 'gpt-5' }),
      'utf8',
    );
    const body = (await (await getConfig()).json()) as WorkspaceConfigResponse;
    expect(body.runnerLock).toBeNull();
    expect(body.browseRoot).toBe('~/kept');
  });

  it('disabling the locked provider clears the lock AND the semaphore accessor immediately', async () => {
    await putConfig({ runnerLock: 'codex' });
    expect(semaphore.runnerLock()).toBe('codex');
    const res = await putProviderEnabled('codex', false);
    expect(res.status).toBe(200);
    expect(((await (await getConfig()).json()) as WorkspaceConfigResponse).runnerLock).toBeNull();
    // D7 #3: this route called no `refresh()` at all before this feature — the accessor must move
    // WITHOUT any other write happening first.
    expect(semaphore.runnerLock()).toBeUndefined();
  });

  it('disabling an unlocked provider does not touch the lock', async () => {
    await putConfig({ runnerLock: 'claude' });
    await putProviderEnabled('codex', false);
    expect(semaphore.runnerLock()).toBe('claude');
  });

  it('D7 #2: a lock-only PUT (no resources key at all) still refreshes the semaphore', async () => {
    // A body that also sets `maxParallel` would pass on the OLD `if (resources !== undefined)`
    // gate and prove nothing — this body carries exactly one key.
    const res = await putConfig({ runnerLock: 'claude' });
    expect(res.status).toBe(200);
    expect(semaphore.runnerLock()).toBe('claude');
  });

  it('D3b item 2: a lock-only PUT reaches every registered participant\'s onRunnerLockChanged, before the pump', async () => {
    const calls: string[] = [];
    const unregister = semaphore.register({
      busySlots: () => 0,
      pump: () => {
        calls.push('pump');
      },
      oldestQueuedAt: () => null,
      onRunnerLockChanged: () => {
        calls.push('lock-changed');
      },
    });
    try {
      await putConfig({ runnerLock: 'claude' });
      expect(calls).toContain('lock-changed');
      // Ordering: the hook must run before the pump sweep, or the first sweep after a lock
      // change still holds runs back on the old verdict.
      expect(calls.indexOf('lock-changed')).toBeLessThan(calls.indexOf('pump'));
    } finally {
      unregister();
    }
  });

  it('D7a negatives: onRunnerLockChanged is NOT called when nothing actually transitioned', async () => {
    let calls = 0;
    const unregister = semaphore.register({
      busySlots: () => 0,
      pump: () => {},
      oldestQueuedAt: () => null,
      onRunnerLockChanged: () => {
        calls += 1;
      },
    });
    try {
      // (i) setting the lock to the value it already has is not a transition.
      await putConfig({ runnerLock: 'claude' });
      expect(calls).toBe(1);
      await putConfig({ runnerLock: 'claude' });
      expect(calls).toBe(1);
      // clearing an already-clear lock is not a transition either.
      await putConfig({ runnerLock: null });
      expect(calls).toBe(2);
      await putConfig({ runnerLock: null });
      expect(calls).toBe(2);
      // (ii) a refresh that carries no lock at all — a resources-only PUT.
      await putConfig({ resources: { maxParallel: 6 } });
      expect(calls).toBe(2);
    } finally {
      unregister();
    }
  });

  it('D7a negative (iii): a failed load() fires no hook, keeping the last good snapshot', async () => {
    let calls = 0;
    const throwing = new WorkspaceSemaphore({
      load: () => Promise.reject(new Error('boom')),
      initial: { runnerLock: 'claude' as const },
    });
    throwing.register({
      busySlots: () => 0,
      pump: () => {},
      oldestQueuedAt: () => null,
      onRunnerLockChanged: () => {
        calls += 1;
      },
    });
    await throwing.refresh();
    expect(calls).toBe(0);
    expect(throwing.runnerLock()).toBe('claude'); // last good snapshot, unmoved
  });

  // ---- GET/PUT /api/v1/workspace/ui-state -------------------------------------

  const getUiState = () => apiRequest(app, '/api/v1/workspace/ui-state');
  const putUiState = (body: unknown) =>
    apiRequest(app, '/api/v1/workspace/ui-state', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const rawUiState = () => JSON.parse(readFileSync(workspaceUiStatePath(), 'utf8')) as Record<string, unknown>;

  it('GET answers {} when no file exists yet', async () => {
    const res = await getUiState();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it('PUT merges shallowly into ~/.cezar/ui-state.json — later keys never drop earlier ones', async () => {
    expect((await putUiState({ appearance: { accent: 'violet' } })).status).toBe(200);
    const res = await putUiState({ sidebar: { collapsed: { cezar: true } } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appearance: { accent: 'violet' },
      sidebar: { collapsed: { cezar: true } },
    });
    expect(rawUiState()).toEqual({
      appearance: { accent: 'violet' },
      sidebar: { collapsed: { cezar: true } },
    });
    // The workspace file, not the boot repo's — the per-repo twin stays empty.
    expect(await (await apiRequest(app, '/api/v1/ui-state')).json()).toEqual({});
  });

  it('round-trips task-table choices and preserves unknown nested siblings', async () => {
    const res = await putUiState({
      taskTable: {
        expandedColumns: { branch: false, workflow: true, futureColumn: false },
        futurePreference: { compact: true },
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      taskTable: {
        expandedColumns: { branch: false, workflow: true, futureColumn: false },
        futurePreference: { compact: true },
      },
    });
    expect(rawUiState()).toEqual({
      taskTable: {
        expandedColumns: { branch: false, workflow: true, futureColumn: false },
        futurePreference: { compact: true },
      },
    });
  });

  it.each([
    ['a non-boolean value', { branch: 'yes' }],
    ['an empty id', { '': true }],
    ['an overlong id', { ['x'.repeat(65)]: true }],
    [
      'more than 50 entries',
      Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`column-${index}`, true])),
    ],
  ])('rejects task-table expanded columns with %s without writing state', async (_case, expandedColumns) => {
    const res = await putUiState({ taskTable: { expandedColumns } });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('round-trips a bounded last project location including query and hash', async () => {
    const lastLocation = {
      projectId: 'storefront',
      pathname: '/p/storefront/runs/run-123',
      search: '?tab=events',
      hash: '#tool-call-9',
    };

    const res = await putUiState({ lastLocation });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ lastLocation });
    expect(await (await getUiState()).json()).toMatchObject({ lastLocation });
    expect(rawUiState()).toMatchObject({ lastLocation });
  });

  it.each([
    ['an empty project id', { projectId: '', pathname: '/p/storefront/' }],
    ['an overlong project id', { projectId: 'p'.repeat(65), pathname: '/p/storefront/' }],
    ['a non-project pathname', { projectId: 'storefront', pathname: '/settings/global' }],
    ['an overlong pathname', { projectId: 'storefront', pathname: `/p/storefront/${'x'.repeat(2035)}` }],
    ['a search without its prefix', { projectId: 'storefront', pathname: '/p/storefront/', search: 'tab=runs' }],
    [
      'an overlong search',
      { projectId: 'storefront', pathname: '/p/storefront/', search: `?${'x'.repeat(4096)}` },
    ],
    ['a hash without its prefix', { projectId: 'storefront', pathname: '/p/storefront/', hash: 'run-1' }],
    [
      'an overlong hash',
      { projectId: 'storefront', pathname: '/p/storefront/', hash: `#${'x'.repeat(2048)}` },
    ],
    ['a non-string field', { projectId: 'storefront', pathname: 42 }],
    ['an unknown field', { projectId: 'storefront', pathname: '/p/storefront/', extra: true }],
  ])('rejects lastLocation with %s without writing state', async (_case, lastLocation) => {
    const res = await putUiState({ lastLocation });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  // Every Settings → Appearance preference has to be listed in `appearanceSchema`: the top-level
  // `.passthrough()` does NOT reach inside `appearance`, so an unlisted key is stripped here and
  // then wiped from the file by the shallow merge. The cockpit adopts this response as
  // authoritative, so a stripped key visibly reverts the control the user just touched — which is
  // exactly what happened to `width` before it was added. The client-side settings test stubs
  // `fetch` with an echo, so this route-level round-trip is the only place that can catch it.
  it('round-trips every appearance preference — accent, density AND reading width', async () => {
    const res = await putUiState({ appearance: { accent: 'violet', density: 'compact', width: 'wide' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appearance: { accent: 'violet', density: 'compact', width: 'wide' },
    });
    expect(rawUiState()).toEqual({
      appearance: { accent: 'violet', density: 'compact', width: 'wide' },
    });
  });

  it('rejects an out-of-enum reading width instead of silently dropping it', async () => {
    const res = await putUiState({ appearance: { width: 'ultrawide' } });
    expect(res.status).toBe(400);
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('accepts bounded provider auth failure dismissals', async () => {
    const response = await putUiState({
      dismissedProviderAuthFailures: {
        claude: 'incident-1',
        opencode: 'incident-9',
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dismissedProviderAuthFailures: {
        claude: 'incident-1',
        opencode: 'incident-9',
      },
    });
  });

  it.each([
    ['an unknown provider', { future: 'incident-1' }],
    ['an empty incident ID', { claude: '' }],
    ['a non-string incident ID', { claude: 1 }],
    ['an overlong incident ID', { claude: 'a'.repeat(129) }],
  ])('rejects provider auth failure dismissals with %s without writing state', async (_case, dismissals) => {
    const response = await putUiState({ dismissedProviderAuthFailures: dismissals });
    expect(response.status).toBe(400);
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow();
  });

  it('unknown keys pass through and survive later PUTs (additive, like the per-repo route)', async () => {
    await putUiState({ futurePref: { nested: 1 } });
    await putUiState({ notifications: { enabled: true } });
    expect(rawUiState()).toEqual({
      futurePref: { nested: 1 },
      notifications: { enabled: true },
    });
  });

  it('rejects a malformed known key instead of writing garbage', async () => {
    const res = await putUiState({ sidebar: { collapsed: { cezar: 'yes' } } });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
    expect(() => readFileSync(workspaceUiStatePath(), 'utf8')).toThrow(); // nothing written
  });

  it('caps the top-level key count at 200, same as the per-repo route', async () => {
    const keysOf = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pref-${i}`, true]));
    expect((await putUiState(keysOf(200))).status).toBe(200);
    const over = await putUiState(keysOf(201));
    expect(over.status).toBe(400);
    expect(((await over.json()) as { error: string }).error).toContain('too many keys');
    // The at-cap state from the previous PUT still stands.
    expect(Object.keys(rawUiState())).toHaveLength(200);
  });
});
