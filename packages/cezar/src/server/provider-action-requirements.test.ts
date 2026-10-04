import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { defaultAgentAccountStore } from '../workspace/agent-accounts.ts';
import { requirementForExistingRun, requirementsForWorkflowRun } from './provider-action-gate.ts';

const run: RunRecord = {
  id: 'r', title: 'Task', task: 'Task', workflow: 'quick-task', status: 'done',
  createdAt: '', tokensUsed: 0, archived: false, runner: 'claude', agentProfile: 'old',
  steps: [{ id: 'work', name: 'Work', kind: 'agent', status: 'done', iterations: 1,
    tokensUsed: 0, backend: 'claude', profileId: 'old', sessionId: 'session' }],
};
const root = '/project';
const accounts = defaultAgentAccountStore();
accounts.accounts = ['claude', 'codex'].map((provider) => ({
  id: 'pb', provider: provider as 'claude' | 'codex', configDir: `/homes/${provider}`, label: '', addedAt: '',
}));
accounts.selections[root] = { claude: 'new', codex: 'pool:codex' };

describe('action requirements match dispatch routing', () => {
  it('keeps concrete run-level IDs pinned to the chosen provider even when another provider owns the same slug', () => {
    expect(requirementsForWorkflowRun({
      workflow: { name: 'quick-task', source: 'built-in', steps: [{ id: 'work', prompt: 'Work' }] },
      accounts, repoRoot: root, fallback: 'codex', overrideAgentProfile: 'pb',
      fallbackAcrossAccountsWhenLimited: false, runnerLock: undefined,
    })[0]).toMatchObject({ provider: 'codex', route: { kind: 'account', accountId: 'pb' } });
  });

  it('checks an explicit Continue account before the recorded session account', () => {
    expect(requirementForExistingRun(run, undefined, false, undefined,
      { agentProfile: 'new', accounts, repoRoot: root })).toMatchObject({
      provider: 'claude', route: { kind: 'account', accountId: 'new' },
    });
  });

  it('checks the target project selection on a provider switch without an account override', () => {
    expect(requirementForExistingRun(run, 'codex', false, undefined,
      { accounts, repoRoot: root })).toMatchObject({
      provider: 'codex', route: { kind: 'pool', provider: 'codex' }, reroutable: true,
    });
  });

  it.each(['pool:codex', 'pool:*'])('lets the explicit %s pool determine its provider candidates', (agentProfile) => {
    const requirement = requirementForExistingRun(run, undefined, false, undefined, { agentProfile, accounts, repoRoot: root });
    expect(requirement.provider).toBe(agentProfile === 'pool:codex' ? 'codex' : undefined);
    expect(requirement.reroutable).toBe(true);
  });

  it('keeps recorded affinity on a normal Continue despite a changed project selection', () => {
    expect(requirementForExistingRun(run, undefined, false, undefined,
      { accounts, repoRoot: root })).toMatchObject({
      provider: 'claude', route: { kind: 'account', accountId: 'old' },
    });
  });

  it('keeps the provider lock above explicit runner and account overrides', () => {
    expect(requirementForExistingRun(run, 'claude', false, 'codex',
      { agentProfile: 'old', accounts, repoRoot: root })).toMatchObject({
      provider: 'codex', route: { kind: 'pool', provider: 'codex' },
    });
  });
});
