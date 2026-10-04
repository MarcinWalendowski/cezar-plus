import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { localCliAuthor } from '../runs/task-author.ts';
import { loadAgentAccountUsage, mergeWriteAgentAccountUsage, recordDispatch, recordLimited } from '../workspace/agent-account-usage.ts';
import { mergeWriteAgentAccounts } from '../workspace/agent-accounts.ts';
import { mergeWriteWorkspaceConfig } from '../workspace/config.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

describe('Continue resolves pools before session affinity', () => {
  let home: string;
  let root: string;
  let store: RunStore;
  let manager: RunManager;
  let saved: Record<string, string | undefined>;
  const authenticated = new Set<string>();
  type Pending = { backend: string; sessionId?: string };
  const pending = (id: string) => (manager as unknown as { pendingContinuations: Map<string, Pending> }).pendingContinuations.get(id);

  beforeEach(async () => {
    saved = Object.fromEntries(['CEZ_HOME', 'CEZ_DRY_RUN', 'CEZ_KB', 'CEZ_CODEX_BIN', 'CEZ_MOCK_STDIN_FILE'].map((key) => [key, process.env[key]]));
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-continue-pool-home-'));
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-continue-pool-repo-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_KB;
    delete process.env.CEZ_CODEX_BIN;
    delete process.env.CEZ_MOCK_STDIN_FILE;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'a.txt'), 'one\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    authenticated.clear();
    authenticated.add('claude:old');
    manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: null, fallbackAcrossAccountsWhenLimited: false } }),
      accountAuth: (provider, id) => authenticated.has(`${provider}:${id ?? 'default'}`) ? 'connected' : 'disconnected',
    });
    await account('claude', 'old');
  });

  afterEach(() => {
    manager.dispose();
    store.flush();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function account(provider: 'claude' | 'codex', id: string, connected = true) {
    const dir = join(home, `${provider}-${id}`);
    mkdirSync(dir, { recursive: true });
    await mergeWriteAgentAccounts((s) => { s.accounts.push({ provider, id, configDir: dir, label: id, addedAt: '' }); });
    if (connected) authenticated.add(`${provider}:${id}`);
  }
  async function select(provider: 'claude' | 'codex', id: string) {
    await mergeWriteAgentAccounts((s) => { s.selections[root] = { ...s.selections[root], [provider]: id }; });
  }
  function finished(profileId: string | undefined = 'old') {
    const record = store.createRun({ author: localCliAuthor(), title: 'Task', task: 'Task', workflow: 'quick-task',
      runner: 'claude', agentProfile: profileId, steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateStep(record.id, 'work', { status: 'done', backend: 'claude', profileId, sessionId: 'old-session' });
    store.updateRun(record.id, { status: 'done' });
    return record.id;
  }
  async function dispatchCount(key: string) {
    return (await loadAgentAccountUsage()).accounts[key]?.dispatch?.count ?? 0;
  }

  it('resolves a different pool member, persists the concrete pair, and starts fresh', async () => {
    await account('codex', 'pb');
    authenticated.delete('claude:old');
    const id = finished();
    expect(await manager.continueRun(id, { agentProfile: 'pool:*' }, true)).toEqual({ ok: true });
    expect(store.getRun(id)).toMatchObject({ runner: 'codex', agentProfile: 'pb' });
    expect(pending(id)).toMatchObject({ backend: 'codex' });
    expect(pending(id)?.sessionId).toBeUndefined();
    expect(await dispatchCount('codex:pb')).toBe(1);
  });

  it('resumes when a pool chooses the recorded provider/account pair', async () => {
    const id = finished();
    expect(await manager.continueRun(id, { agentProfile: 'pool:claude' }, true)).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('old');
    expect(pending(id)?.sessionId).toBe('old-session');
    expect(await dispatchCount('claude:old')).toBe(1);
  });

  it('resolves the target provider project pool after an explicit provider switch', async () => {
    await account('codex', 'pb');
    await select('codex', 'pool:codex');
    const id = finished();
    expect(await manager.continueRun(id, { runner: 'codex' }, true)).toEqual({ ok: true });
    expect(store.getRun(id)).toMatchObject({ runner: 'codex', agentProfile: 'pb' });
    expect(pending(id)?.sessionId).toBeUndefined();
    expect(await dispatchCount('codex:pb')).toBe(1);
  });

  it('excludes a disabled connected provider even when its account ranks ahead of enabled Claude', async () => {
    await account('codex', 'pb');
    await mergeWriteAgentAccountUsage((s) => recordDispatch(s, 'claude:old'));
    await mergeWriteWorkspaceConfig((config) => { config.disabledProviders = ['codex']; });
    const id = finished();
    expect(await manager.continueRun(id, { agentProfile: 'pool:*' }, true)).toEqual({ ok: true });
    expect(store.getRun(id)).toMatchObject({ runner: 'claude', agentProfile: 'old' });
    expect(pending(id)?.sessionId).toBe('old-session');
    expect(await dispatchCount('claude:old')).toBe(2);
    expect(await dispatchCount('codex:pb')).toBe(0);
  });

  it.each(['explicit', 'target-selection'] as const)('refuses a disabled provider %s pool without any run or cursor writes', async (source) => {
    await account('codex', 'pb');
    await select('codex', 'pool:codex');
    await mergeWriteWorkspaceConfig((config) => { config.disabledProviders = ['codex']; });
    const id = finished();
    const before = structuredClone(store.getRun(id));
    const options = source === 'explicit' ? { agentProfile: 'pool:codex' } : { runner: 'codex' as const };
    expect(await manager.continueRun(id, options, true)).toMatchObject({ ok: false });
    expect(store.getRun(id)).toEqual(before);
    expect(pending(id)).toBeUndefined();
    expect(await dispatchCount('codex:pb')).toBe(0);
  });

  it('refuses an all-disabled wildcard pool without any run or cursor writes', async () => {
    await account('codex', 'pb');
    await mergeWriteWorkspaceConfig((config) => { config.disabledProviders = ['claude', 'codex']; });
    const id = finished();
    const before = structuredClone(store.getRun(id));
    const usageBefore = await loadAgentAccountUsage();
    expect(await manager.continueRun(id, { agentProfile: 'pool:*' }, true)).toMatchObject({ ok: false });
    expect(store.getRun(id)).toEqual(before);
    expect(await loadAgentAccountUsage()).toEqual(usageBefore);
    expect(pending(id)).toBeUndefined();
  });

  it('rejects a model incompatible with the actual wildcard-pool provider without writes', async () => {
    await account('codex', 'pb');
    authenticated.delete('claude:old');
    const id = finished();
    const before = structuredClone(store.getRun(id));
    expect(await manager.continueRun(id, { agentProfile: 'pool:*', model: 'sonnet' }, true))
      .toMatchObject({ ok: false, error: "model 'sonnet' is not a codex model" });
    expect(store.getRun(id)).toEqual(before);
    expect(pending(id)).toBeUndefined();
    expect(await dispatchCount('codex:pb')).toBe(0);
  });

  it('refuses a pool with only disconnected or waitable members without default spawn or cursor writes', async () => {
    await account('codex', 'pb');
    await mergeWriteAgentAccountUsage((s) => recordLimited(s, 'codex:pb', { source: 'usage-limit', until: new Date(Date.now() + 60_000).toISOString() }));
    const id = finished();
    const before = structuredClone(store.getRun(id));
    expect(await manager.continueRun(id, { agentProfile: 'pool:codex' }, true)).toMatchObject({ ok: false });
    expect(store.getRun(id)).toEqual(before);
    expect(pending(id)).toBeUndefined();
    expect(await dispatchCount('codex:pb')).toBe(0);
  });

  it('preserves a recorded discovered default when the project selection changes', async () => {
    await account('claude', 'new');
    await select('claude', 'new');
    const id = finished();
    store.updateRun(id, { agentProfile: undefined });
    store.updateStep(id, 'work', { profileId: undefined });
    expect(await manager.continueRun(id, {}, true)).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('default');
    expect(pending(id)?.sessionId).toBe('old-session');
  });

  it('keeps a normal concrete session pinned despite a new project pool selection', async () => {
    await account('claude', 'new');
    await select('claude', 'pool:*');
    const id = finished();
    expect(await manager.continueRun(id, {}, true)).toEqual({ ok: true });
    expect(store.getRun(id)).toMatchObject({ runner: 'claude', agentProfile: 'old' });
    expect(pending(id)?.sessionId).toBe('old-session');
    expect(await dispatchCount('claude:old')).toBe(0);
  });

  it('honors a deliberately updated run account instead of resuming its older session', async () => {
    await account('claude', 'new');
    const id = finished();
    store.updateRun(id, { agentProfile: 'new' });
    expect(await manager.continueRun(id, {}, true)).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('new');
    expect(pending(id)?.sessionId).toBeUndefined();
  });

  it('skips a connected but limited member while choosing a runnable pool member', async () => {
    await account('claude', 'new');
    await mergeWriteAgentAccountUsage((s) => recordLimited(s, 'claude:old', {
      source: 'usage-limit', until: new Date(Date.now() + 60_000).toISOString(),
    }));
    const id = finished();
    expect(await manager.continueRun(id, { agentProfile: 'pool:claude' }, true)).toEqual({ ok: true });
    expect(store.getRun(id)?.agentProfile).toBe('new');
    expect(pending(id)?.sessionId).toBeUndefined();
    expect(await dispatchCount('claude:old')).toBe(0);
    expect(await dispatchCount('claude:new')).toBe(1);
  });

  it('narrows a wildcard pool to the global provider lock and clears a foreign inherited model', async () => {
    await account('codex', 'pb');
    manager.dispose();
    manager = new RunManager(store, root, {
      semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 2, memoryLimitMb: null, runnerLock: 'codex' } }),
      accountAuth: (provider, profile) => authenticated.has(`${provider}:${profile ?? 'default'}`) ? 'connected' : 'disconnected',
    });
    const id = finished();
    store.updateRun(id, { model: 'sonnet' });
    expect(await manager.continueRun(id, { runner: 'claude', agentProfile: 'pool:*' }, true)).toEqual({ ok: true });
    expect(store.getRun(id)).toMatchObject({ runner: 'codex', agentProfile: 'pb' });
    expect(store.getRun(id)?.model).toBeUndefined();
    expect(pending(id)?.sessionId).toBeUndefined();
    expect(await dispatchCount('codex:pb')).toBe(1);
  });

  it('executes a fresh dry-run session on the selected account with persisted conversation context', async () => {
    await account('claude', 'new');
    authenticated.delete('claude:old');
    const capture = join(home, 'mock-input.ndjson');
    process.env.CEZ_MOCK_STDIN_FILE = capture;
    const id = finished();
    store.appendEvent(id, { type: 'text', text: 'PRIOR_SCOPE_EVIDENCE' });
    expect(await manager.continueRun(id, { agentProfile: 'pool:claude', text: 'mock:done finish this' })).toEqual({ ok: true });
    await expect.poll(() => store.getRun(id)?.steps.find((s) => s.id === 'continue-1')?.status, { timeout: 15_000 }).toBe('done');
    expect(store.getRun(id)?.steps.find((s) => s.id === 'continue-1')).toMatchObject({ backend: 'claude', profileId: 'new' });
    const input = readFileSync(capture, 'utf8');
    expect(input).toContain('PRIOR_SCOPE_EVIDENCE');
    expect(input).toContain('## New user instruction');
    expect(await dispatchCount('claude:new')).toBe(1);
    manager.finish(id);
    await expect.poll(() => manager.isActive(id), { timeout: 5_000 }).toBe(false);
  }, 20_000);
});
