import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAgentAccountUsage, mergeWriteAgentAccountUsage, recordDispatch } from './agent-account-usage.ts';
import { mergeWriteAgentAccounts } from './agent-accounts.ts';
import { resolvePoolForDispatch, resolvePoolForProvider } from './agent-route-select.ts';
import { mergeWriteWorkspaceConfig } from './config.ts';

describe('shared pool resolution excludes disabled providers', () => {
  let home: string;
  const repoRoot = '/isolated-project';
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-disabled-pools-'));
    vi.stubEnv('CEZ_HOME', home);
    await mergeWriteWorkspaceConfig((config) => { config.disabledProviders = ['codex']; });
    await mergeWriteAgentAccounts((s) => {
      s.defaults = { claude: 'pool:*', codex: 'pool:codex' };
    });
    await mergeWriteAgentAccountUsage((s) => recordDispatch(s, 'claude:default'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it.each(['pool:*', undefined])('uses enabled Claude for explicit or inherited wildcard %s despite Codex ranking first', async (agentProfile) => {
    expect(await resolvePoolForDispatch({ agentProfile, fallbackProvider: 'claude', repoRoot }))
      .toEqual({ provider: 'claude', accountId: 'default' });
    const usage = await loadAgentAccountUsage();
    expect(usage.accounts['claude:default']?.dispatch?.count).toBe(2);
    expect(usage.accounts['codex:default']?.dispatch).toBeUndefined();
  });

  it('does not dispatch a pinned step pool on a disabled provider', async () => {
    const before = await loadAgentAccountUsage();
    expect(await resolvePoolForProvider({ provider: 'codex', repoRoot })).toBeUndefined();
    expect(await loadAgentAccountUsage()).toEqual(before);
  });
});
