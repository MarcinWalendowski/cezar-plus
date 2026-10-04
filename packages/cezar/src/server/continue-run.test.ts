import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { agentAccountsPath } from '../paths.ts';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { defaultWorkspaceConfig } from '../workspace/config.ts';
import { localCliAuthor } from '../runs/task-author.ts';

/**
 * `POST /api/v1/runs/:id/continue` runner/model override (#401) — the follow-up composer lets the
 * user pick which backend/model reopen the session. Contract: the parsed override is handed to
 * the manager verbatim; an empty POST omits both (the run's current backend is kept — backward
 * compat); a bad runner is a 400. A capturing stub is all the boundary needs (start-run pattern).
 */
describe('POST /api/v1/runs/:id/continue override', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let runId: string;
  type ContinueOpts = {
    text?: string;
    images?: Array<{ type: string; source: { media_type: string; data: string } }>;
    runner?: string;
    model?: string;
    agentProfile?: string;
  };
  let captured: { id: string; opts: ContinueOpts } | undefined;
  let home: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    // Agent accounts resolve against `~/.cezar/` — pinned to a temp home so the machine's real
    // logins can neither be read nor decide the outcome.
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-continue-home-'));
    process.env.CEZ_HOME = home;
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-continue-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    runId = store.createRun({ author: localCliAuthor(),
      title: 't',
      workflow: 'quick-task',
      task: 't',
      steps: [],
    }).id;
    const manager = {
      continueRun: (id: string, opts: ContinueOpts = {}) => {
        captured = { id, opts };
        return { ok: true };
      },
    } as unknown as RunManager;
    app = createApp({ repoRoot, store, manager, version: '0.0.0-test',
      providerAuth: new ProviderAuthService({ platform: 'linux', probeJunie: async () => ({ connected: true }),
        runCommand: async (executable) => ({
          stdout: executable.includes('claude') ? '{"loggedIn":true}' : executable.includes('codex') ? 'Logged in using ChatGPT' : '└  1 credential',
          stderr: '', exitCode: 0,
        }),
      }),
    });
  });

  afterEach(() => {
    store.flush();
    for (const dir of [repoRoot, home]) rmSync(dir, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  /** One stored Claude login beside the discovered account. */
  const writeAccounts = () => {
    const path = agentAccountsPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        accounts: [
          { id: 'klaudiusz', provider: 'claude', configDir: '~/.claude-klaudiusz', label: 'Klaudiusz' },
        ],
      }),
      'utf8',
    );
  };

  const post = (body: unknown) =>
    apiRequest(app, `/api/v1/runs/${runId}/continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('plumbs a runner + model override through to the manager', async () => {
    const res = await post({ runner: 'codex', model: 'gpt-5.1-codex' });
    expect(res.status).toBe(200);
    expect(captured?.opts.runner).toBe('codex');
    expect(captured?.opts.model).toBe('gpt-5.1-codex');
  });

  it('an empty POST omits both — the run keeps its current backend (backward compat)', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(captured?.opts.runner).toBeUndefined();
    expect(captured?.opts.model).toBeUndefined();
  });

  it('still carries a follow-up text alongside the override', async () => {
    const res = await post({ text: 'keep going', runner: 'opencode' });
    expect(res.status).toBe(200);
    expect(captured?.opts.text).toBe('keep going');
    expect(captured?.opts.runner).toBe('opencode');
  });

  it('rejects a model override while locked but still permits switching runners', async () => {
    writeFileSync(
      join(repoRoot, '.ai', 'cezar', 'config.json'),
      JSON.stringify({ modelsLocked: true }),
      'utf8',
    );

    expect((await post({ runner: 'codex', model: 'gpt-5.6-codex' })).status).toBe(409);
    expect(captured).toBeUndefined();

    expect((await post({ runner: 'codex' })).status).toBe(200);
    expect(captured?.opts.runner).toBe('codex');
    expect(captured?.opts.model).toBeUndefined();
  });

  /** The follow-up composer is a full composer, so a screenshot pasted into it has to reach the
   *  reopened session — as content blocks, the same shape `POST /messages` hands the engine. */
  it('converts pasted images into content blocks for the manager', async () => {
    const res = await post({ text: 'like this', images: [{ mediaType: 'image/png', data: 'AAAA' }] });
    expect(res.status).toBe(200);
    expect(captured?.opts.images).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('rejects a media type outside the allowlist, and more attachments than a message may carry', async () => {
    // Since #950 the follow-up composer takes PDF/TXT/MD too — the refusal is what is left
    // outside that allowlist, not "anything that is not an image".
    expect((await post({ images: [{ mediaType: 'application/zip', data: 'AAAA' }] })).status).toBe(400);
    const five = Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: 'AAAA' }));
    expect((await post({ images: five })).status).toBe(400);
    expect(captured).toBeUndefined();
  });

  /** #950 — a brief pasted into the follow-up composer must reach the reopened session as a file
   *  block, which the engine turns into a path; the composer is a full composer either way. */
  it('takes a PDF or a markdown file and hands the manager a file block', async () => {
    const res = await post({ text: 'read this', images: [{ mediaType: 'application/pdf', data: 'AAAA' }] });
    expect(res.status).toBe(200);
    expect(captured?.opts.images).toEqual([{ type: 'file', mediaType: 'application/pdf', data: 'AAAA' }]);
  });

  it('rejects an unknown runner with a 400 and never reaches the manager', async () => {
    const res = await post({ runner: 'gemini' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  /* Agent accounts (spec 2026-07-29-agent-profiles): the follow-up pill can name which login
     reopens the session, on the same terms `POST /runs` takes one at creation. */

  it('plumbs the picked agent account through to the manager', async () => {
    writeAccounts();
    const res = await post({ agentProfile: 'klaudiusz' });
    expect(res.status).toBe(200);
    expect(captured?.opts.agentProfile).toBe('klaudiusz');
  });

  it('takes `default` explicitly — the discovered account, whatever the project is set to', async () => {
    const res = await post({ agentProfile: 'default' });
    expect(res.status).toBe(200);
    expect(captured?.opts.agentProfile).toBe('default');
  });

  it('an empty POST names no account — the run keeps the one it is on', async () => {
    const res = await post({});
    expect(res.status).toBe(200);
    expect(captured?.opts.agentProfile).toBeUndefined();
  });

  it('rejects an account that no longer exists with a 400, and never reaches the manager', async () => {
    // A USER just picked this from a menu, so "unknown account" is honest and actionable —
    // quietly reopening the session on another login would cross a billing boundary.
    writeAccounts();
    const res = await post({ agentProfile: 'deleted-one' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown claude account: deleted-one' });
    expect(captured).toBeUndefined();
  });

  it('resolves the account against the runner the continuation will USE', async () => {
    // The claude login is unknown to codex, so a switch that carries it is refused rather than
    // silently ignored.
    writeAccounts();
    const res = await post({ runner: 'codex', agentProfile: 'klaudiusz' });
    expect(res.status).toBe(400);
    expect(captured).toBeUndefined();
  });

  const configureAccountGate = async (oldConnected: boolean, selectedConnected: boolean) => {
    delete process.env.CEZ_DRY_RUN;
    writeFileSync(agentAccountsPath(), JSON.stringify({ accounts: [
      { id: 'old', provider: 'claude', configDir: join(home, 'old'), label: 'Old' },
      { id: 'selected', provider: 'claude', configDir: join(home, 'selected'), label: 'Selected' },
      { id: 'selected', provider: 'codex', configDir: join(home, 'codex-selected'), label: 'Codex selected' },
    ], selections: { [repoRoot]: { codex: 'selected' } } }));
    const run = store.createRun({ author: localCliAuthor(), title: 'Account gate', workflow: 'quick-task', task: 'task', runner: 'claude', agentProfile: 'old',
      steps: [{ id: 'task', name: 'Task', kind: 'agent' }],
    });
    runId = run.id;
    store.updateRun(runId, { status: 'done' });
    store.updateStep(runId, 'task', { status: 'done', backend: 'claude', profileId: 'old', sessionId: 'session-old' });
    const config = defaultWorkspaceConfig();
    config.resources.fallbackAcrossAccountsWhenLimited = false;
    const auth = new ProviderAuthService({ platform: 'linux', probeJunie: async () => ({ connected: true }),
      runCommand: async (executable, _args, _timeout, env) => {
        if (executable.includes('claude')) {
          const connected = env?.CLAUDE_CONFIG_DIR === join(home, 'selected') ? selectedConnected : oldConnected;
          return { stdout: JSON.stringify({ loggedIn: connected }), stderr: '', exitCode: connected ? 0 : 1 };
        }
        return { stdout: executable.includes('codex') ? 'Logged in using ChatGPT' : '└  1 credential', stderr: '', exitCode: 0 };
      },
    });
    await auth.status();
    await auth.profileStatus('claude', { id: 'old', configDir: join(home, 'old') });
    await auth.profileStatus('claude', { id: 'selected', configDir: join(home, 'selected') });
    await auth.profileStatus('codex', { id: 'selected', configDir: join(home, 'codex-selected') });
    app = createApp({ repoRoot, store, version: 'test', providerAuth: auth,
      workspaceConfig: { load: async () => config, mergeWrite: async (mutator) => mutator(config) ?? config },
      manager: { continueRun: (id: string, opts: ContinueOpts) => { captured = { id, opts }; return { ok: true }; } } as unknown as RunManager,
    });
  };

  it('gates the selected account rather than the disconnected old session account', async () => {
    await configureAccountGate(false, true);
    expect((await post({ agentProfile: 'selected' })).status).toBe(200);
    expect(captured?.opts.agentProfile).toBe('selected');
  });

  it('refuses a disconnected selected account despite a connected old session and leaves the run unchanged', async () => {
    await configureAccountGate(true, false);
    const before = JSON.stringify(store.getRun(runId));
    expect((await post({ agentProfile: 'selected' })).status).toBe(409);
    expect(captured).toBeUndefined();
    expect(JSON.stringify(store.getRun(runId))).toBe(before);
  });

  it('uses the target provider selection when switching providers without an explicit account', async () => {
    await configureAccountGate(false, false);
    expect((await post({ runner: 'codex' })).status).toBe(200);
    expect(captured?.opts.runner).toBe('codex');
  });

  it('validates an unknown explicit account before an unavailable old account gate', async () => {
    await configureAccountGate(false, false);
    expect((await post({ agentProfile: 'missing' })).status).toBe(400);
    expect(captured).toBeUndefined();
  });

  it('accepts supported pools only when balancing is enabled', async () => {
    const saved = process.env.CEZ_ACCOUNT_USAGE;
    try {
      delete process.env.CEZ_ACCOUNT_USAGE;
      expect((await post({ agentProfile: 'pool:claude' })).status).toBe(409);
      expect(captured).toBeUndefined();
      process.env.CEZ_ACCOUNT_USAGE = '1';
      expect((await post({ agentProfile: 'pool:claude' })).status).toBe(200);
      expect(captured?.opts.agentProfile).toBe('pool:claude');
    } finally {
      if (saved === undefined) delete process.env.CEZ_ACCOUNT_USAGE;
      else process.env.CEZ_ACCOUNT_USAGE = saved;
    }
  });

  it('404s for an unknown run before validating the body', async () => {
    const res = await apiRequest(app, '/api/v1/runs/missing/continue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
