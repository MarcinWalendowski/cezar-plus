import { describe, expect, it } from 'vitest';
import { agentAccountRouteId, agentProfileSchema, selectAgentProfileInputSchema } from './agent-profiles.ts';
import { accountUsageRowSchema } from './agent-account-usage.ts';

const profile = (provider: 'claude' | 'codex', id = 'pb', isDefault = false) => ({ provider, id, isDefault });

describe('agent account management route identity', () => {
  it('qualifies equal stored ids with their provider without changing the profile id', () => {
    const claude = profile('claude');
    const codex = profile('codex');
    expect(agentAccountRouteId(claude)).toBe('claude:pb');
    expect(agentAccountRouteId(codex)).toBe('codex:pb');
    expect(claude.id).toBe('pb');
    expect(codex.id).toBe('pb');
  });

  it('preserves the released discovered-default route spelling', () => {
    expect(agentAccountRouteId(profile('claude', 'default', true))).toBe('default:claude');
    expect(agentAccountRouteId(profile('codex', 'default', true))).toBe('default:codex');
  });

  it('keeps bare profile and selection ids on the wire', () => {
    const row = agentProfileSchema.parse({ ...profile('codex'), label: 'Work', configDir: '~/.codex-pb', path: '/home/person/.codex-pb', exists: true, looksValid: true, files: [] });
    const selection = selectAgentProfileInputSchema.parse({ projectId: 'repo', provider: 'codex', profileId: row.id });
    expect(row.id).toBe('pb');
    expect(selection.profileId).toBe('pb');
    expect(agentAccountRouteId(row)).toBe('codex:pb');
  });

  it('preserves released usage ids while deriving separate management/cache identities', () => {
    const usage = (provider: 'claude' | 'codex', id: string, isDefault = false) => accountUsageRowSchema.parse({ ...profile(provider, id, isDefault), label: 'Work', inflight: 0, limited: false });
    const claude = usage('claude', 'pb');
    const codex = usage('codex', 'pb');
    const discovered = usage('codex', 'default:codex', true);
    expect([claude.id, codex.id, discovered.id]).toEqual(['pb', 'pb', 'default:codex']);
    expect([agentAccountRouteId(claude), agentAccountRouteId(codex), agentAccountRouteId(discovered)]).toEqual(['claude:pb', 'codex:pb', 'default:codex']);
  });
});
