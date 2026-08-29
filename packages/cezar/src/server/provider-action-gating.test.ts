import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthService, type ProviderId } from '../core/provider-auth.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { mergeWriteAgentAccountUsage, recordLimited } from '../workspace/agent-account-usage.ts';
import { defaultWorkspaceConfig, type WorkspaceConfig } from '../workspace/config.ts';
import { RunManager, type StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import {
  fallbackOffMessage,
  noEligibleFallbackMessage,
  NO_PROVIDER_AUTHORIZED_MESSAGE,
} from './provider-action-gate.ts';

const DISABLED_MESSAGE = 'Codex is disabled. Enable it in Settings → Agents → Providers.';
const CLAUDE_UNAVAILABLE_MESSAGE = 'Claude Code credentials are unavailable. Authorize it in Settings → Agents → Providers.';

const memoryWorkspaceConfig = (disabledProviders: ProviderId[] = ['codex']) => {
  let config: WorkspaceConfig = { ...defaultWorkspaceConfig(), disabledProviders };
  return {
    load: async () => config,
    mergeWrite: async (mutator: (current: WorkspaceConfig) => WorkspaceConfig | void) => {
      config = mutator(config) ?? config;
      return config;
    },
  };
};

const providerAuth = () => new ProviderAuthService({
  platform: 'linux',
  runCommand: async (executable) => {
    if (executable === 'claude') return { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 };
    if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
    return {
      stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n└  1 credential',
      stderr: '',
      exitCode: 0,
    };
  },
});

describe('provider action gating', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let app: Hono;
  let startRun: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let continueRun: ReturnType<typeof vi.fn>;
  const savedModelsLocked = process.env.CEZ_AGENT_MODELS_LOCKED;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedFollowups = process.env.CEZ_FOLLOWUPS;

  const makeRun = (input: StartRunInput): RunRecord => store.createRun({ author: localCliAuthor(),
    title: 'Task',
    workflow: 'quick-task',
    task: input.task,
    runner: input.runner,
    steps: [],
  });

  const createExistingRun = (backend?: ProviderId): RunRecord => {
    const run = store.createRun({ author: localCliAuthor(),
      title: 'Existing',
      workflow: 'quick-task',
      task: 'Existing task',
      runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    if (backend) {
      // A persisted active backend belongs to a live run. Keeping the record queued would
      // model the prompt-authoring window, where provider availability deliberately does not
      // gate mutations of the existing task.
      store.updateRun(run.id, { status: 'running', currentStepId: 'task' });
      store.updateStep(run.id, 'task', { backend, status: 'running' });
    }
    return run;
  };

  beforeEach(() => {
    delete process.env.CEZ_AGENT_MODELS_LOCKED;
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_FOLLOWUPS = '1';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-provider-action-gating-'));
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    startRun = vi.fn((_workflow: WorkflowDef, input: StartRunInput) => makeRun(input));
    sendMessage = vi.fn(() => true);
    continueRun = vi.fn(() => ({ ok: true }));
    const manager = { startRun, sendMessage, continueRun } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: 'test',
      providerAuth: providerAuth(),
      workspaceConfig: memoryWorkspaceConfig(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedModelsLocked === undefined) delete process.env.CEZ_AGENT_MODELS_LOCKED;
    else process.env.CEZ_AGENT_MODELS_LOCKED = savedModelsLocked;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedFollowups === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = savedFollowups;
  });

  const expectDisabled = async (response: Response) => {
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: DISABLED_MESSAGE });
  };

  it('blocks a new run selected with a disabled provider before starting it', async () => {
    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Task',
        runner: 'codex',
        steps: [{ id: 'task', prompt: '{{task}}' }],
      }),
    });

    await expectDisabled(response);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('keeps every runner selectable under the explicit model lock despite provider preferences', async () => {
    process.env.CEZ_AGENT_MODELS_LOCKED = '1';
    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Task',
        runner: 'codex',
        steps: [{ id: 'task', prompt: '{{task}}' }],
      }),
    });

    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runner: 'codex', model: undefined }),
    );
  });

  it('blocks a mixed inline workflow when one agent step uses a disabled provider', async () => {
    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        task: 'Task',
        runner: 'claude',
        steps: [
          { id: 'first', prompt: '{{task}}' },
          { id: 'check', command: 'npm test' },
          { id: 'second', prompt: '{{task}}', runner: 'codex' },
        ],
      }),
    });

    await expectDisabled(response);
    expect(startRun).not.toHaveBeenCalled();
  });

  it('blocks planning when the configured default runner is disabled', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ defaultRunner: 'codex' }), 'utf8');

    const response = await apiRequest(app, '/api/v1/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Plan it' }),
    });

    await expectDisabled(response);
  });

  it('delivers into an already-open session with NO credential check at all (Solution 4c)', async () => {
    // `.ai/specs/2026-08-25-logged-out-account-fallback.md`, Solution 4c: the gate MOVES below
    // `manager.sendMessage`, it does not merely relax — delivering into a live session invokes no
    // provider, so a disabled/logged-out fallback provider must not strand the message. Codex is
    // disabled in this fixture's default workspace config; the run's own backend is codex too, and
    // this now succeeds anyway.
    const run = createExistingRun('codex');
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Continue' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: true });
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('blocks a continue override before resuming the run', async () => {
    const run = createExistingRun('claude');
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'codex' }),
    });

    await expectDisabled(response);
    expect(continueRun).not.toHaveBeenCalled();
  });

  it('uses the run runner, not a historical step backend, for a no-override continue', async () => {
    const run = createExistingRun('codex');
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(continueRun).toHaveBeenCalledOnce();
  });

  it('uses the active step backend, not a later historical step, for a live message', async () => {
    const run = store.createRun({ author: localCliAuthor(),
      title: 'Retrying',
      workflow: 'mixed',
      task: 'Retrying task',
      runner: 'claude',
      steps: [
        { id: 'retry', name: 'Retry', kind: 'agent' },
        { id: 'later', name: 'Later', kind: 'agent' },
      ],
    });
    store.updateRun(run.id, { currentStepId: 'retry' });
    store.updateStep(run.id, 'retry', { backend: 'claude', status: 'running' });
    store.updateStep(run.id, 'later', { backend: 'codex', status: 'done' });

    const response = await apiRequest(app, `/api/v1/runs/${run.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Continue retrying' }),
    });

    expect(response.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('blocks starting an inbox todo with a disabled provider', async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'todos.json'), JSON.stringify([{ id: 'todo-1', summary: 'Follow up' }]), 'utf8');
    const response = await apiRequest(app, '/api/v1/todos/todo-1/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runner: 'codex' }),
    });

    await expectDisabled(response);
    expect(startRun).not.toHaveBeenCalled();
  });
});

/**
 * The gate re-probes before it refuses (`providerActionError` in `server.ts`).
 *
 * Auth state is served stale-while-revalidate, so a cached "disconnected" can predate a login cezar
 * never saw — someone typing `claude auth login` in a terminal. Refusing on that would lock a user
 * out of their own cockpit with no way back but waiting, which is exactly what a short cache window
 * used to paper over, at the cost of making every reader of `GET /api/v1/providers/status`
 * periodically pay for a CLI spawn.
 */
describe('the gate verifies before it refuses', () => {
  let repoRoot: string;
  let store: RunStore;
  let startRun: ReturnType<typeof vi.fn>;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    // The whole point is the real probe path, so dry-run (which reports everything connected) must
    // be off or these would pass without exercising anything.
    delete process.env.CEZ_DRY_RUN;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gate-verify-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    startRun = vi.fn((_workflow: WorkflowDef, input: StartRunInput) => store.createRun({ author: localCliAuthor(),
      title: 'Task',
      workflow: 'quick-task',
      task: input.task,
      runner: input.runner,
      steps: [],
    }));
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** A claude whose login state the test controls, with a clock it can advance. */
  const setup = (options: { disabled?: ProviderId[] } = {}) => {
    let now = 1_000;
    const state = { claudeLoggedIn: false, probes: 0 };
    const providerAuth = new ProviderAuthService({
      platform: 'linux',
      now: () => now,
      runCommand: async (executable) => {
        state.probes += 1;
        if (executable === 'claude') {
          return state.claudeLoggedIn
            ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
            : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 };
        }
        if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
        return { stdout: '└  1 credential', stderr: '', exitCode: 0 };
      },
    });
    const app = createApp({
      repoRoot,
      store,
      manager: { startRun, sendMessage: vi.fn(() => true), continueRun: vi.fn(() => ({ ok: true })) } as unknown as RunManager,
      version: 'test',
      providerAuth,
      workspaceConfig: memoryWorkspaceConfig(options.disabled ?? []),
    });
    return { app, providerAuth, state, advance: (ms: number) => { now += ms; } };
  };

  const start = (app: Hono, runner: ProviderId) => apiRequest(app, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Task', runner, steps: [{ id: 'task', prompt: '{{task}}' }] }),
  });

  it('starts the run when the cached refusal is out of date — a terminal login is honoured', async () => {
    const { app, providerAuth, state, advance } = setup();
    await providerAuth.status(); // learns: claude disconnected
    advance(61_000); // …and that answer goes stale
    state.claudeLoggedIn = true; // meanwhile, the user logs in from a terminal

    const response = await start(app, 'claude');
    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('still refuses when the fresh answer agrees — verifying is not a way in', async () => {
    // Codex/OpenCode/pi disabled: with the new `assessAccountViability` rung, an ENABLED healthy
    // account elsewhere would legitimately reroute this (that is the feature this spec ships).
    // Disabling every alternative keeps this test's own premise — claude specifically, and nothing
    // rescues it — true under the new gate too.
    const { app, providerAuth, advance } = setup({ disabled: ['codex', 'opencode', 'pi'] });
    await providerAuth.status();
    advance(61_000);

    const response = await start(app, 'claude');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: NO_PROVIDER_AUTHORIZED_MESSAGE });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('refuses a runtime-rejected account that the fresh reprobe still finds disconnected', async () => {
    // `.ai/specs/2026-08-25-logged-out-account-fallback.md`, Solution 1: the per-account
    // `runtimeRejections` entry this writes is deliberately DIFFERENT from the provider-wide
    // banner latch (`runtimeFailures`) — it clears the moment a SUBSEQUENT probe finds the exact
    // account connected again, because it is a ROUTING fact ("can I spawn on this login right
    // now?"), not an acknowledgeable incident. That means an account which genuinely reconnects
    // after being rejected is legitimately routable again — proven at the unit level in
    // `workspace/account-viability.test.ts` ("the per-account runtime rejection, and its clear
    // rules"), not here. This gate-level test keeps the account ACTUALLY disconnected throughout,
    // so the fresh reprobe `providerActionError` always performs before refusing agrees with the
    // rejection rather than clearing it.
    const { app, providerAuth } = setup({ disabled: ['codex', 'opencode', 'pi'] });
    await providerAuth.status(); // claude starts disconnected
    providerAuth.reportRuntimeAuthFailure('claude'); // and a run's own credentials were rejected
    // `state.claudeLoggedIn` stays false — the account is disconnected for real, not just latched.

    const response = await start(app, 'claude');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: NO_PROVIDER_AUTHORIZED_MESSAGE });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('spawns nothing to re-read a DISABLED provider — that is settings, not credentials', async () => {
    const { app, providerAuth, state } = setup({ disabled: ['codex'] });
    await providerAuth.status();
    const warmed = state.probes;

    const response = await start(app, 'codex');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: DISABLED_MESSAGE });
    expect(state.probes).toBe(warmed);
  });

  it('costs nothing on the happy path — a warm connected answer is not re-probed', async () => {
    const { app, providerAuth, state } = setup();
    state.claudeLoggedIn = true;
    await providerAuth.status();
    const warmed = state.probes;

    expect((await start(app, 'claude')).status).toBe(201);
    expect(state.probes).toBe(warmed);
  });

  /**
   * The discovered DEFAULT is not the only login dispatch can reach.
   * `resolvePoolForDispatch`/`resolvePoolForProvider` (`workspace/agent-route-select.ts`) already
   * route a run around a dead default onto a healthy pool member — measured in production doing
   * exactly that on run `da0119ec`, 2026-08-23. This gate did not know that until now: a project
   * pooled onto two Claude logins still 409'd every task the moment the discovered default logged
   * out, however healthy the other login was.
   */
  describe('a project pooled onto more than one login', () => {
    const savedHome = { value: undefined as string | undefined };
    let home: string;

    beforeEach(() => {
      savedHome.value = process.env.CEZ_HOME;
      home = mkdtempSync(join(tmpdir(), 'cez-gate-pool-home-'));
      process.env.CEZ_HOME = home;
    });

    afterEach(() => {
      if (savedHome.value === undefined) delete process.env.CEZ_HOME;
      else process.env.CEZ_HOME = savedHome.value;
      rmSync(home, { recursive: true, force: true });
    });

    /** A claude default AND a `secondary` pool member, each with its own login state, keyed by
     *  whether the probe carries the secondary's `CLAUDE_CONFIG_DIR`. */
    const setupPool = async (options: { defaultLoggedIn: boolean; secondaryLoggedIn: boolean }) => {
      const secondaryDir = join(home, 'secondary-claude');
      await mergeWriteAgentAccounts((store) => {
        store.accounts.push({ id: 'secondary', provider: 'claude', configDir: secondaryDir, label: 'Secondary', addedAt: '2026-08-24T00:00:00.000Z' });
        store.defaults.claude = 'pool:claude';
        return store;
      });
      const providerAuth = new ProviderAuthService({
        platform: 'linux',
        runCommand: async (executable, _args, _timeoutMs, env) => {
          if (executable === 'claude') {
            const loggedIn = env?.CLAUDE_CONFIG_DIR ? options.secondaryLoggedIn : options.defaultLoggedIn;
            return loggedIn
              ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
              : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 };
          }
          if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
          return { stdout: '└  1 credential', stderr: '', exitCode: 0 };
        },
      });
      const app = createApp({
        repoRoot,
        store,
        manager: { startRun, sendMessage: vi.fn(() => true), continueRun: vi.fn(() => ({ ok: true })) } as unknown as RunManager,
        version: 'test',
        providerAuth,
        workspaceConfig: memoryWorkspaceConfig([]),
      });
      await providerAuth.status(); // warms/learns the default's state, same as the sibling tests
      return app;
    };

    it('starts the run on the default logout — a connected pool member covers it', async () => {
      const app = await setupPool({ defaultLoggedIn: false, secondaryLoggedIn: true });

      const response = await start(app, 'claude');
      expect(response.status).toBe(201);
      expect(startRun).toHaveBeenCalledTimes(1);
    });

    it('still refuses when NEITHER the default NOR the pool has a connected login', async () => {
      // The negative control. A pool check that always says yes would pass the case above and
      // silently wave every task through regardless of whether anything in the pool actually works.
      //
      // The project's claude selection is `pool:claude` (single-provider), which forces the
      // candidate set to claude accounts only even under the new `assessAccountViability` rung
      // (mirroring `resolvePoolForProvider`'s own narrowing) — codex, healthy in this fixture, is
      // globally eligible, so the terminal message names the fallback-off case rather than
      // claiming nothing anywhere is authorized (which would be false: codex is).
      const app = await setupPool({ defaultLoggedIn: false, secondaryLoggedIn: false });

      const response = await start(app, 'claude');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: fallbackOffMessage('claude') });
      expect(startRun).not.toHaveBeenCalled();
    });

    it('a DISABLED provider still refuses even with a connected pool member — that is a settings fact', async () => {
      const secondaryDir = join(home, 'secondary-claude');
      await mergeWriteAgentAccounts((store) => {
        store.accounts.push({ id: 'secondary', provider: 'claude', configDir: secondaryDir, label: 'Secondary', addedAt: '2026-08-24T00:00:00.000Z' });
        store.defaults.claude = 'pool:claude';
        return store;
      });
      const providerAuth = new ProviderAuthService({
        platform: 'linux',
        runCommand: async (executable, _args, _timeoutMs, env) => {
          if (executable === 'claude') {
            return env?.CLAUDE_CONFIG_DIR
              ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
              : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 };
          }
          if (executable === 'codex') return { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 };
          return { stdout: '└  1 credential', stderr: '', exitCode: 0 };
        },
      });
      const app = createApp({
        repoRoot,
        store,
        manager: { startRun, sendMessage: vi.fn(() => true), continueRun: vi.fn(() => ({ ok: true })) } as unknown as RunManager,
        version: 'test',
        providerAuth,
        workspaceConfig: memoryWorkspaceConfig(['claude']),
      });
      await providerAuth.status();

      const response = await start(app, 'claude');
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Claude Code is disabled. Enable it in Settings → Agents → Providers.',
      });
      expect(startRun).not.toHaveBeenCalled();
    });
  });
});

/**
 * V2 — the gate stops refusing when a fallback exists.
 * `.ai/specs/2026-08-25-logged-out-account-fallback.md`, Solution 2 / "Message copy, decided".
 * One case per row of the outcomes table, plus V4's pinned-site negative control.
 */
describe('the fallback gate (Phase 2, assessAccountViability)', () => {
  let repoRoot: string;
  let home: string;
  let store: RunStore;
  let startRun: ReturnType<typeof vi.fn>;
  const savedHome = process.env.CEZ_HOME;

  const workspaceConfigWith = (opts: { disabled?: ProviderId[]; fallback?: boolean } = {}) => {
    const config: WorkspaceConfig = {
      ...defaultWorkspaceConfig(),
      disabledProviders: opts.disabled ?? [],
      resources: { ...defaultWorkspaceConfig().resources, fallbackAcrossAccountsWhenLimited: opts.fallback ?? true },
    };
    return { load: async () => config, mergeWrite: async () => config };
  };

  /** claude default/secondary and codex default, each independently connected or not — the SAME
   *  `env?.CLAUDE_CONFIG_DIR` discriminator `setupPool` above uses. opencode/pi answer `connected`
   *  only when `opencodeConnected` is passed, so "only OpenCode connected" has a fixture. */
  const buildAuth = (opts: {
    claudeDefault: boolean;
    claudeSecondary?: boolean;
    codexDefault: boolean;
    opencodeConnected?: boolean;
  }) => new ProviderAuthService({
    platform: 'linux',
    runCommand: async (executable, _args, _timeoutMs, env) => {
      if (executable === 'claude') {
        const loggedIn = env?.CLAUDE_CONFIG_DIR ? (opts.claudeSecondary ?? false) : opts.claudeDefault;
        return loggedIn
          ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
          : { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 };
      }
      if (executable === 'codex') {
        return opts.codexDefault
          ? { stdout: 'Logged in using ChatGPT', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'not logged in', exitCode: 1 };
      }
      return opts.opencodeConnected
        ? { stdout: '┌  Credentials ~/.local/share/opencode/auth.json\n└  1 credential', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'no credentials', exitCode: 1 };
    },
  });

  const buildApp = (providerAuth: ProviderAuthService, workspaceConfig = workspaceConfigWith()) => createApp({
    repoRoot,
    store,
    manager: { startRun, sendMessage: vi.fn(() => true), continueRun: vi.fn(() => ({ ok: true })) } as unknown as RunManager,
    version: 'test',
    providerAuth,
    workspaceConfig,
  });

  const startClaude = (app: Hono, body: Record<string, unknown> = {}) => apiRequest(app, '/api/v1/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: 'Task', runner: 'claude', steps: [{ id: 'task', prompt: '{{task}}' }], ...body }),
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-gate-fallback-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-gate-fallback-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    startRun = vi.fn((_workflow: WorkflowDef, input: StartRunInput) => store.createRun({
      author: localCliAuthor(),
      title: 'Task',
      workflow: 'quick-task',
      task: input.task,
      runner: input.runner,
      agentProfile: input.agentProfile,
      steps: [],
    }));
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  it('THE REPORTED BUG: pool:*, fallback off, claude wholly logged out, codex healthy → 201', async () => {
    await mergeWriteAgentAccounts((s) => {
      s.defaults.claude = 'pool:*';
      return s;
    });
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: false }));

    const response = await startClaude(app);
    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('the same bug with a STORED EXPLICIT account instead of a pool → also 201', async () => {
    // `poolHasConnectedAccount` cannot reach this at all (`route.kind !== 'pool'` returns false) —
    // pins the gap the old gate had no answer for.
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: true }));

    const response = await startClaude(app);
    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('claude logged out, every connected codex account LIMITED → 201, not 409 — the run parks', async () => {
    await mergeWriteAgentAccountUsage((s) =>
      recordLimited(s, 'codex:default', { source: 'usage-limit', until: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: true }));

    const response = await startClaude(app);
    expect(response.status).toBe(201);
    expect(startRun).toHaveBeenCalledTimes(1);
  });

  it('V8: /plan gates on `runnable`, not `placeable` — a waitable-only codex still 409s', async () => {
    // `.ai/specs/2026-08-25-logged-out-account-fallback.md`, Solution 4b: `placeable` would be
    // TRUE here (a waitable codex candidate exists), and gating `/plan` on it would hand
    // `planChain` a chooser with nothing RUNNABLE to offer, spawn the logged-out claude default,
    // and degrade to the one-step `fallback: true` plan instead of refusing honestly — the
    // mutation this case exists to catch (V8's own).
    await mergeWriteAgentAccountUsage((s) =>
      recordLimited(s, 'codex:default', { source: 'usage-limit', until: new Date(Date.now() + 3_600_000).toISOString() }),
    );
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: true }));

    const response = await apiRequest(app, '/api/v1/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Plan it' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: fallbackOffMessage('claude') });
  });

  it('nothing connected on any provider → 409 "No agent provider is authorized…"', async () => {
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: false });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: true }));

    const response = await startClaude(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: NO_PROVIDER_AUTHORIZED_MESSAGE });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('fallback off, explicit route, healthy sibling on ANOTHER provider → 409, fallback-off message', async () => {
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: false }));

    const response = await startClaude(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: fallbackOffMessage('claude') });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('an explicitly selected HEALTHY secondary while the default is disconnected → 201, either setting', async () => {
    const secondaryDir = join(home, 'secondary-claude');
    await mergeWriteAgentAccounts((s) => {
      s.accounts.push({ id: 'secondary', provider: 'claude', configDir: secondaryDir, label: 'Secondary', addedAt: '2026-08-24T00:00:00.000Z' });
      s.selections[repoRoot] = { claude: 'secondary' };
      return s;
    });
    for (const fallback of [true, false]) {
      const providerAuth = buildAuth({ claudeDefault: false, claudeSecondary: true, codexDefault: false });
      const app = buildApp(providerAuth, workspaceConfigWith({ fallback }));
      const response = await startClaude(app);
      expect(response.status).toBe(201);
    }
  });

  it('a DEAD explicit account with a healthy sibling: 409 with fallback off, 201 with it on', async () => {
    // An EXPLICIT ACCOUNT route never triggers `poolHasConnectedAccount` (pool-only), which is
    // what warms a non-default account's cache in the pooled-login fixtures above. Warm it here
    // explicitly, the way `warmAgentKnowledge` would at boot — a cold peek reads `unknown`, and
    // `unknown` counts as eligible/connected by design (Solution 1), which would make this case
    // pass for the wrong reason if the cache were left cold.
    const secondaryDir = join(home, 'secondary-claude');
    await mergeWriteAgentAccounts((s) => {
      s.accounts.push({ id: 'secondary', provider: 'claude', configDir: secondaryDir, label: 'Secondary', addedAt: '2026-08-24T00:00:00.000Z' });
      s.selections[repoRoot] = { claude: 'default' };
      return s;
    });
    const offAuth = buildAuth({ claudeDefault: false, claudeSecondary: true, codexDefault: false });
    await offAuth.profileStatus('claude', { id: 'secondary', configDir: secondaryDir });
    const offResponse = await startClaude(buildApp(offAuth, workspaceConfigWith({ fallback: false })));
    expect(offResponse.status).toBe(409);
    expect(await offResponse.json()).toEqual({ error: fallbackOffMessage('claude') });

    const onAuth = buildAuth({ claudeDefault: false, claudeSecondary: true, codexDefault: false });
    await onAuth.profileStatus('claude', { id: 'secondary', configDir: secondaryDir });
    const onResponse = await startClaude(buildApp(onAuth, workspaceConfigWith({ fallback: true })));
    expect(onResponse.status).toBe(201);
  });

  it('the composer override, not the project route: overrides a healthy pool onto a dead account', async () => {
    const overrideDir = join(home, 'override-claude');
    await mergeWriteAgentAccounts((s) => {
      s.accounts.push({ id: 'claude-default', provider: 'claude', configDir: overrideDir, label: 'Dup', addedAt: '2026-08-24T00:00:00.000Z' });
      s.defaults.claude = 'pool:claude';
      return s;
    });
    // The project's pool is healthy (claude default connected), but the body names a specific
    // logged-out account and fallback is off — the override must be what gets gated, not the
    // project's own pool selection. Warmed explicitly for the same cold-cache reason as above.
    const providerAuth = buildAuth({ claudeDefault: true, codexDefault: false });
    await providerAuth.profileStatus('claude', { id: 'claude-default', configDir: overrideDir });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: false }));
    const response = await startClaude(app, { agentProfile: 'claude-default' });
    expect(response.status).toBe(409);
  });

  it('a mixed-provider workflow with ONE disconnected pinned provider — every requirement must place', async () => {
    const workflow: WorkflowDef = {
      name: 'mixed',
      source: 'built-in',
      steps: [
        { id: 'spec', name: 'Spec', prompt: '{{task}}', runner: 'claude' },
        { id: 'build', name: 'Build', prompt: '{{task}}' },
      ],
    };
    const offAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const offResponse = await apiRequest(buildApp(offAuth, workspaceConfigWith({ fallback: false })), '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Task', runner: 'codex', steps: workflow.steps }),
    });
    expect(offResponse.status).toBe(409);
    expect(await offResponse.json()).toEqual({ error: fallbackOffMessage('claude') });

    const onAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const onResponse = await apiRequest(buildApp(onAuth, workspaceConfigWith({ fallback: true })), '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Task', runner: 'codex', steps: workflow.steps }),
    });
    expect(onResponse.status).toBe(201);
  });

  it('only OpenCode connected → 409, the no-eligible-fallback message, not "no agent provider"', async () => {
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: false, opencodeConnected: true });
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: true }));

    const response = await startClaude(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: noEligibleFallbackMessage('claude') });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('codex disabled and required, claude connected → unchanged disabled message, viability untouched', async () => {
    const providerAuth = buildAuth({ claudeDefault: true, codexDefault: false });
    const app = buildApp(providerAuth, workspaceConfigWith({ disabled: ['codex'], fallback: true }));

    const response = await apiRequest(app, '/api/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'Task', runner: 'codex', steps: [{ id: 'task', prompt: '{{task}}' }] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: DISABLED_MESSAGE });
    expect(startRun).not.toHaveBeenCalled();
  });

  it('site 3, live delivery: an open session on a logged-out provider still delivers, no status read', async () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'Existing',
      workflow: 'quick-task',
      task: 'Existing task',
      runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    store.updateRun(run.id, { status: 'running', currentStepId: 'task' });
    store.updateStep(run.id, 'task', { backend: 'claude', status: 'running' });
    const providerAuth = buildAuth({ claudeDefault: false, codexDefault: false });
    const statusSpy = vi.spyOn(providerAuth, 'status');
    const app = buildApp(providerAuth, workspaceConfigWith({ fallback: true }));

    const response = await apiRequest(app, `/api/v1/runs/${run.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'keep going' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: true });
    expect(statusSpy).not.toHaveBeenCalled();
  });

  it('site 3, reopen: a waiting/inactive run reopens onto a healthy fallback, refuses when nothing is', async () => {
    const run = store.createRun({
      author: localCliAuthor(),
      title: 'Waiting',
      workflow: 'quick-task',
      task: 'Waiting task',
      runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    store.updateRun(run.id, { status: 'waiting' });
    // No live session for THIS run: `sendMessage` must answer `false` so the ladder actually
    // reaches the reopen branch — the shared `startRun`-only mock at the top of this describe
    // answers `true` unconditionally, which would deliver into a session that does not exist.
    const reopenApp = (providerAuth: ProviderAuthService, workspaceConfig: ReturnType<typeof workspaceConfigWith>) => createApp({
      repoRoot,
      store,
      manager: {
        startRun,
        sendMessage: vi.fn(() => false),
        continueRun: vi.fn(() => ({ ok: true })),
        isActive: vi.fn(() => false),
      } as unknown as RunManager,
      version: 'test',
      providerAuth,
      workspaceConfig,
    });

    const healthyAuth = buildAuth({ claudeDefault: false, codexDefault: true });
    const healthyResponse = await apiRequest(
      reopenApp(healthyAuth, workspaceConfigWith({ fallback: true })),
      `/api/v1/runs/${run.id}/messages`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'still there?' }) },
    );
    expect(healthyResponse.status).toBe(200);
    expect(await healthyResponse.json()).toEqual({ continued: true });

    const nothingAuth = buildAuth({ claudeDefault: false, codexDefault: false });
    const nothingResponse = await apiRequest(
      reopenApp(nothingAuth, workspaceConfigWith({ fallback: true })),
      `/api/v1/runs/${run.id}/messages`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'still there?' }) },
    );
    expect(nothingResponse.status).toBe(409);
    expect(await nothingResponse.json()).toEqual({ error: NO_PROVIDER_AUTHORIZED_MESSAGE });
  });

  /**
   * V4 — the two pinned sites stay pinned, byte-identical, in the SAME fixture that makes
   * `POST /runs` answer `201` above (claude wholly logged out, codex healthy, fallback off): the
   * whole point is that one workspace state produces `201` on a reroutable site and `409` on a
   * pinned one.
   */
  describe('V4: sites 7 and 8 keep blocking', () => {
    const buildRunWithSession = () => {
      const run = store.createRun({
        author: localCliAuthor(),
        title: 'Handoff',
        workflow: 'quick-task',
        task: 'Handoff task',
        runner: 'claude',
        steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
      });
      store.updateStep(run.id, 'task', { sessionId: 'sess-1' });
      return run;
    };

    it('POST /runs/:id/open-in-cli refuses byte-identically while POST /runs succeeds', async () => {
      await mergeWriteAgentAccounts((s) => {
        s.defaults.claude = 'pool:*';
        return s;
      });
      const providerAuth = buildAuth({ claudeDefault: false, codexDefault: true });
      const app = buildApp(providerAuth, workspaceConfigWith({ fallback: false }));

      const started = await startClaude(app);
      expect(started.status).toBe(201);

      const run = buildRunWithSession();
      const response = await apiRequest(app, `/api/v1/runs/${run.id}/open-in-cli`, { method: 'POST' });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: CLAUDE_UNAVAILABLE_MESSAGE });
    });

    it('POST /runs/:id/open-in (CLI target) refuses byte-identically while POST /runs succeeds', async () => {
      await mergeWriteAgentAccounts((s) => {
        s.defaults.claude = 'pool:*';
        return s;
      });
      const providerAuth = buildAuth({ claudeDefault: false, codexDefault: true });
      const app = buildApp(providerAuth, workspaceConfigWith({ fallback: false }));

      const started = await startClaude(app);
      expect(started.status).toBe(201);

      const run = buildRunWithSession();
      const response = await apiRequest(app, `/api/v1/runs/${run.id}/open-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'cli:claude' }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: CLAUDE_UNAVAILABLE_MESSAGE });
    });
  });
});

describe('provider availability preserves existing execution', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  let runId: string | undefined;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedCodexBin = process.env.CEZ_CODEX_BIN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    // Resolved from this file, not the cwd: the bundled dry-run mock lives at the package root's
    // scripts/, so the path holds wherever vitest is invoked from and survives the tree moving.
    process.env.CEZ_CODEX_BIN = join(
      import.meta.dirname,
      '../../scripts/mock-codex-app-server.mjs',
    );
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-provider-continuity-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot);
  });

  afterEach(() => {
    if (runId) manager.cancel(runId);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedCodexBin === undefined) delete process.env.CEZ_CODEX_BIN;
    else process.env.CEZ_CODEX_BIN = savedCodexBin;
  });

  const waitFor = async (predicate: () => boolean, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('run did not reach the expected state');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  it('dequeues a task created before disable and reaches its later provider step', async () => {
    const workspaceConfig = memoryWorkspaceConfig([]);
    const app = createApp({
      repoRoot,
      store,
      manager,
      version: 'test',
      providerAuth: providerAuth(),
      workspaceConfig,
    });
    const workflow: WorkflowDef = {
      name: 'mixed-existing',
      source: 'built-in',
      steps: [
        { id: 'claude', name: 'Claude', prompt: '{{task}}', runner: 'claude' },
        { id: 'codex', name: 'Codex', prompt: '{{task}}', runner: 'codex' },
      ],
    };

    const engine = manager as unknown as { pump: () => Promise<void> };
    const pausedPump = vi.spyOn(engine, 'pump').mockResolvedValue();
    const run = manager.startRun(workflow, { author: localCliAuthor(),
      task: 'mock:native-codex-ask choose a library',
      runner: 'claude',
      worktree: false,
    });
    runId = run.id;
    expect(store.getRun(run.id)?.status).toBe('queued');

    const disabled = await apiRequest(app, '/api/v1/providers/codex/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    pausedPump.mockRestore();
    void engine.pump();

    await waitFor(() => {
      const current = store.getRun(run.id);
      return current?.currentStepId === 'codex' && current.steps.find((step) => step.id === 'codex')?.status === 'waiting';
    });

    const current = store.getRun(run.id);
    expect(current?.steps.map((step) => ({ id: step.id, status: step.status, backend: step.backend }))).toEqual([
      { id: 'claude', status: 'done', backend: 'claude' },
      { id: 'codex', status: 'waiting', backend: 'codex' },
    ]);
  }, 30_000);
});
