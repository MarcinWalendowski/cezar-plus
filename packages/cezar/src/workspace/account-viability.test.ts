import { describe, expect, it } from 'vitest';
import { parseAgentRoute } from '@loki-labs/better-cezar-contract';
import { ProviderAuthService } from '../core/provider-auth.ts';
import {
  accountUsageKey,
  defaultAgentAccountUsageStore,
  recordLimited,
  type AgentAccountUsageStore,
} from './agent-account-usage.ts';
import type { ResolvedAgentProfile } from './agent-profiles.ts';
import {
  assessAccountViability,
  authOf,
  candidatesFor,
  type DispatchRequirement,
  type ViabilityContext,
  type ViabilityInput,
} from './account-viability.ts';

/**
 * V1 — `.ai/specs/2026-08-25-logged-out-account-fallback.md`.
 *
 * The assertion that matters most in this file is the one on `authOf`'s cache separation: it is
 * the case an earlier draft of the spec got backwards (heal the dead account, kill the healthy
 * one), and it is why that assertion comes first rather than the simpler tiering table.
 */

const NOW = Date.now();

function profile(provider: 'claude' | 'codex', id: string): ResolvedAgentProfile {
  return {
    id,
    provider,
    label: id,
    configDir: `~/.${provider}-${id}`,
    path: `/home/u/.${provider}-${id}`,
    isDefault: id === 'default',
  };
}

const CLAUDE_DEFAULT = profile('claude', 'default');
const CLAUDE_SECONDARY = profile('claude', 'secondary');
const CODEX_DEFAULT = profile('codex', 'default');
const CODEX_SECONDARY = profile('codex', 'secondary');

const keyOf = (p: ResolvedAgentProfile) => accountUsageKey(p.provider, p.isDefault ? undefined : p.id);

function usage(build: (s: AgentAccountUsageStore) => void = () => {}): AgentAccountUsageStore {
  const s = defaultAgentAccountUsageStore();
  build(s);
  return s;
}

/** A hand-built context — no real `ProviderAuthService` needed for the pure tiering table. */
function fakeCtx(opts: {
  connected?: readonly ResolvedAgentProfile[];
  disconnected?: readonly ResolvedAgentProfile[];
  rejectedKeys?: readonly string[];
} = {}): ViabilityContext {
  const connectedIds = new Set((opts.connected ?? []).map(keyOf));
  const disconnectedIds = new Set((opts.disconnected ?? []).map(keyOf));
  const rejected = new Set(opts.rejectedKeys ?? []);
  return {
    rejected: (provider, profileId) => rejected.has(accountUsageKey(provider, profileId)),
    peekDefaultRowRaw: (provider) => {
      const key = accountUsageKey(provider, undefined);
      if (connectedIds.has(key)) return { provider, status: 'connected' };
      if (disconnectedIds.has(key)) return { provider, status: 'disconnected' };
      return undefined;
    },
    peekProfileStatus: (provider, profileId) => {
      const key = accountUsageKey(provider, profileId);
      if (connectedIds.has(key)) return { provider, status: 'connected', profileId };
      if (disconnectedIds.has(key)) return { provider, status: 'disconnected', profileId };
      return undefined;
    },
  };
}

function input(overrides: Partial<ViabilityInput>): ViabilityInput {
  return {
    profiles: [CLAUDE_DEFAULT, CLAUDE_SECONDARY, CODEX_DEFAULT],
    usage: usage(),
    auth: () => 'connected',
    disabledProviders: [],
    providerRows: [
      { provider: 'claude', status: 'connected' },
      { provider: 'codex', status: 'connected' },
      { provider: 'opencode', status: 'disconnected' },
      { provider: 'pi', status: 'disconnected' },
    ],
    requirements: [],
    ...overrides,
  };
}

describe('authOf — tiering', () => {
  it('connected + in quota reads as connected', () => {
    const ctx = fakeCtx({ connected: [CLAUDE_DEFAULT] });
    expect(authOf(CLAUDE_DEFAULT, ctx)).toBe('connected');
  });

  it('a cached disconnected row reads as disconnected, quota aside', () => {
    const ctx = fakeCtx({ disconnected: [CLAUDE_DEFAULT] });
    expect(authOf(CLAUDE_DEFAULT, ctx)).toBe('disconnected');
  });

  it('no cache entry at all reads as unknown, never disconnected', () => {
    const ctx = fakeCtx();
    expect(authOf(CLAUDE_DEFAULT, ctx)).toBe('unknown');
  });

  it('the freshly-probed disconnected DEFAULT reads as disconnected, not as unknown/runnable', async () => {
    // Drive a REAL ProviderAuthService: `status()` writes `this.completed`, never
    // `completedProfiles` — routing through `peekProfileStatus` for a default account would read
    // that as "no information" and treat it as connected, which is the exact bug this pins.
    const service = new ProviderAuthService({
      runCommand: async (executable) =>
        executable === 'claude'
          ? { stdout: '{"loggedIn":false}', stderr: '', exitCode: 1 }
          : { stdout: 'not logged in', stderr: '', exitCode: 1 },
    });
    await service.status();
    expect(service.peekProfileStatus('claude', 'default')).toBeUndefined();
    const ctx: ViabilityContext = {
      rejected: () => false,
      peekDefaultRowRaw: (p) => service.peekDefaultRowRaw(p),
      peekProfileStatus: (p, id) => service.peekProfileStatus(p, id),
    };
    expect(authOf(CLAUDE_DEFAULT, ctx)).toBe('disconnected');
  });

  it('the banner latch must not steer routing, in either direction', async () => {
    const service = new ProviderAuthService({
      runCommand: async (executable) =>
        executable === 'claude'
          ? { stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }
          : { stdout: 'logged in using ChatGPT', stderr: '', exitCode: 0 },
    });
    await service.status();
    await service.profileStatus('claude', { id: 'secondary', configDir: '/secondary' });
    service.reportRuntimeAuthFailure('claude', 'secondary');

    const ctx: ViabilityContext = {
      rejected: (p, id) => service.isRuntimeRejected(p, id),
      peekDefaultRowRaw: (p) => service.peekDefaultRowRaw(p),
      peekProfileStatus: (p, id) => service.peekProfileStatus(p, id),
    };
    // (a) the rejected secondary is disconnected
    expect(authOf(CLAUDE_SECONDARY, ctx)).toBe('disconnected');
    // (b) the healthy default is UNTOUCHED — this is the assertion an earlier draft would fail
    expect(authOf(CLAUDE_DEFAULT, ctx)).toBe('connected');
    // (c) the cockpit banner (peekStatus) is still latched for claude's default row
    const peeked = service.peekStatus();
    expect(peeked?.providers.find((row) => row.provider === 'claude')).toMatchObject({
      status: 'disconnected',
      authFailureId: expect.any(String),
    });
  });

  it('the per-account runtime rejection clears independently of the provider-wide latch', async () => {
    const service = new ProviderAuthService({
      runCommand: async () => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }),
    });
    const report = service.reportRuntimeAuthFailure('claude', 'secondary');
    expect(report).not.toBeNull();
    const incidentId = report!.status.authFailureId;
    expect(service.isRuntimeRejected('claude', 'secondary')).toBe(true);
    expect(service.isRuntimeRejected('claude', undefined)).toBe(false);

    // A subsequent CONNECTED probe of exactly that account clears ITS rejection only, and the
    // provider-wide latch is untouched — `clearRuntimeAuthFailure` still returns true afterwards.
    await service.profileStatus('claude', { id: 'secondary', configDir: '/secondary' });
    expect(service.isRuntimeRejected('claude', 'secondary')).toBe(false);
    expect(service.clearRuntimeAuthFailure('claude', incidentId)).toBe(true);
  });

  it('clearRuntimeAuthFailure clears both maps for that incident id', async () => {
    const service = new ProviderAuthService({
      runCommand: async () => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }),
    });
    const report = service.reportRuntimeAuthFailure('claude', 'secondary');
    const incidentId = report!.status.authFailureId;
    expect(service.clearRuntimeAuthFailure('claude', incidentId)).toBe(true);
    expect(service.isRuntimeRejected('claude', 'secondary')).toBe(false);
    // A stale/second clear of the same (already-cleared) incident id is a no-op, not a crash.
    expect(service.clearRuntimeAuthFailure('claude', incidentId)).toBe(false);
  });

  it('a STEP-LESS default probe does not clear a DIFFERENT account\'s rejection', async () => {
    const service = new ProviderAuthService({
      runCommand: async () => ({ stdout: '{"loggedIn":true}', stderr: '', exitCode: 0 }),
    });
    service.reportRuntimeAuthFailure('claude', 'secondary');
    // The default's own fresh probe clears ONLY the default's key.
    await service.status({ refresh: true });
    expect(service.isRuntimeRejected('claude', 'secondary')).toBe(true);
  });
});

describe('candidatesFor', () => {
  const base = { provider: undefined, reroutable: false } satisfies Partial<DispatchRequirement>;

  it('pool:* with no provider pin, setting off, yields every enabled profile-capable account', () => {
    const req: DispatchRequirement = { ...base, route: { kind: 'pool' } };
    const result = candidatesFor(req, input({}));
    expect(result).toHaveLength(3);
  });

  it('pool:* WITH a provider pin narrows to that provider only, even on the wildcard', () => {
    const req: DispatchRequirement = { provider: 'claude', reroutable: false, route: { kind: 'pool' } };
    const result = candidatesFor(req, input({}));
    expect(result.map((p) => p.provider)).toEqual(['claude', 'claude']);
  });

  it('pool:codex yields codex whether reroutable is true or false', () => {
    const req: DispatchRequirement = { provider: 'codex', reroutable: false, route: { kind: 'pool', provider: 'codex' } };
    const result = candidatesFor(req, input({}));
    expect(result).toEqual([CODEX_DEFAULT]);
  });

  it('a non-reroutable account route yields exactly one profile', () => {
    const req: DispatchRequirement = {
      provider: 'claude',
      reroutable: false,
      route: { kind: 'account', accountId: 'secondary' },
    };
    expect(candidatesFor(req, input({}))).toEqual([CLAUDE_SECONDARY]);
  });

  it('a non-reroutable account route with a dangling id degrades to the provider default', () => {
    const req: DispatchRequirement = {
      provider: 'claude',
      reroutable: false,
      route: { kind: 'account', accountId: 'ghost' },
    };
    expect(candidatesFor(req, input({}))).toEqual([CLAUDE_DEFAULT]);
  });

  it('a REROUTABLE account route yields every enabled profile-capable account', () => {
    const req: DispatchRequirement = {
      provider: 'claude',
      reroutable: true,
      route: { kind: 'account', accountId: 'default' },
    };
    expect(candidatesFor(req, input({}))).toHaveLength(3);
  });

  it('a disabled provider never enters the candidate set', () => {
    const req: DispatchRequirement = { provider: undefined, reroutable: false, route: { kind: 'pool' } };
    const result = candidatesFor(req, input({ disabledProviders: ['codex'] }));
    expect(result.every((p) => p.provider !== 'codex')).toBe(true);
  });
});

describe('assessAccountViability', () => {
  it('tiers a candidate: connected+open -> runnable, connected+limited -> waitable, disconnected -> disconnected', () => {
    const u = usage((s) => recordLimited(s, keyOf(CODEX_DEFAULT), { source: 'test' }, new Date(NOW)));
    const req: DispatchRequirement = { provider: undefined, reroutable: true, route: { kind: 'pool' } };
    const result = assessAccountViability(
      input({
        usage: u,
        auth: (p) => (p.id === 'secondary' && p.provider === 'claude' ? 'disconnected' : 'connected'),
        requirements: [req],
      }),
    );
    const r = result.requirements[0]!;
    expect(r.runnable.map((p) => p.id)).toEqual(['default']); // claude:default
    expect(r.waitable.map((p) => p.id)).toEqual(['default']); // codex:default
    expect(r.disconnected.map((p) => p.id)).toEqual(['secondary']);
    expect(r.placeable).toBe(true);
  });

  it('THE REPORTED BUG: runner claude + pool:* + fallback OFF still places on codex', () => {
    // Every claude account disconnected, one codex account connected, fallback off. The run-level
    // requirement must carry provider: undefined (from the ROUTE, pool:*), never 'claude' (from
    // providersRequiredByWorkflow) — that one-token difference is the reported bug.
    const req: DispatchRequirement = { provider: undefined, reroutable: true, route: { kind: 'pool' } };
    const result = assessAccountViability(
      input({
        auth: (p) => (p.provider === 'claude' ? 'disconnected' : 'connected'),
        requirements: [req],
      }),
    );
    expect(result.placeable).toBe(true);
    expect(result.requirements[0]!.runnable.map((p) => p.provider)).toEqual(['codex']);

    // The mutation this pins: attributing the run-level requirement to 'claude' instead.
    const wrongReq: DispatchRequirement = { provider: 'claude', reroutable: true, route: { kind: 'pool' } };
    const wrong = assessAccountViability(
      input({
        auth: (p) => (p.provider === 'claude' ? 'disconnected' : 'connected'),
        requirements: [wrongReq],
      }),
    );
    expect(wrong.placeable).toBe(false);
  });

  it('a dead explicit account with a healthy sibling: account-scoped refuses, provider-scoped (reroutable) does not', () => {
    const authFn = (p: ResolvedAgentProfile) => (p.id === 'default' && p.provider === 'claude' ? 'disconnected' : 'connected');
    const nonReroutable: DispatchRequirement = {
      provider: 'claude',
      reroutable: false,
      route: { kind: 'account', accountId: 'default' },
    };
    const scoped = assessAccountViability(input({ auth: authFn, requirements: [nonReroutable] }));
    expect(scoped.placeable).toBe(false);
    expect(scoped.blocked).toEqual(['claude']);
    expect(scoped.anyEligibleConnected).toBe(true);

    const reroutable: DispatchRequirement = { ...nonReroutable, reroutable: true };
    const open = assessAccountViability(input({ auth: authFn, requirements: [reroutable] }));
    expect(open.placeable).toBe(true);
    expect(open.requirements[0]!.runnable.map((p) => p.id)).toContain('secondary');
  });

  it('a mixed-provider workflow: one disconnected pinned provider blocks the whole AND, never a some()', () => {
    const authFn = (p: ResolvedAgentProfile) => (p.provider === 'claude' ? 'disconnected' : 'connected');
    const claudeReq: DispatchRequirement = { provider: 'claude', reroutable: false, route: { kind: 'account', accountId: 'default' } };
    const codexReq: DispatchRequirement = { provider: 'codex', reroutable: false, route: { kind: 'account', accountId: 'default' } };
    const result = assessAccountViability(input({ auth: authFn, requirements: [claudeReq, codexReq] }));
    expect(result.placeable).toBe(false);
    expect(result.blocked).toEqual(['claude']);

    const reroutable = assessAccountViability(
      input({ auth: authFn, requirements: [{ ...claudeReq, reroutable: true }, { ...codexReq, reroutable: true }] }),
    );
    expect(reroutable.placeable).toBe(true);
    // Two reroutable requirements may share the same fallback account — both name the SAME
    // `codex:default`, and being chosen by one does not remove it from the other's candidate set.
    expect(reroutable.requirements[0]!.runnable.map((p) => `${p.provider}:${p.id}`)).toEqual(['codex:default']);
    expect(reroutable.requirements[1]!.runnable.map((p) => `${p.provider}:${p.id}`)).toEqual(['codex:default']);
  });

  it('anyConnectedAnywhere/anyEligibleConnected: connected-OpenCode is authorized but not eligible', () => {
    const result = assessAccountViability(
      input({
        auth: () => 'disconnected',
        providerRows: [
          { provider: 'claude', status: 'disconnected' },
          { provider: 'codex', status: 'disconnected' },
          { provider: 'opencode', status: 'connected' },
          { provider: 'pi', status: 'disconnected' },
        ],
        requirements: [{ provider: 'claude', reroutable: true, route: { kind: 'pool' } }],
      }),
    );
    expect(result.anyConnectedAnywhere).toBe(true);
    expect(result.anyEligibleConnected).toBe(false);
  });

  it('nothing connected anywhere: both flags false', () => {
    const result = assessAccountViability(
      input({
        auth: () => 'disconnected',
        providerRows: [
          { provider: 'claude', status: 'disconnected' },
          { provider: 'codex', status: 'disconnected' },
          { provider: 'opencode', status: 'disconnected' },
          { provider: 'pi', status: 'disconnected' },
        ],
        requirements: [{ provider: 'claude', reroutable: true, route: { kind: 'pool' } }],
      }),
    );
    expect(result.anyConnectedAnywhere).toBe(false);
    expect(result.anyEligibleConnected).toBe(false);
  });

  it('a waitable-only requirement is placeable (parked), never refused', () => {
    const u = usage((s) => {
      recordLimited(s, keyOf(CLAUDE_DEFAULT), { source: 'test' }, new Date(NOW));
      recordLimited(s, keyOf(CLAUDE_SECONDARY), { source: 'test' }, new Date(NOW));
      recordLimited(s, keyOf(CODEX_DEFAULT), { source: 'test' }, new Date(NOW));
    });
    const req: DispatchRequirement = { provider: undefined, reroutable: true, route: { kind: 'pool' } };
    const result = assessAccountViability(input({ usage: u, auth: () => 'connected', requirements: [req] }));
    expect(result.placeable).toBe(true);
    expect(result.requirements[0]!.runnable).toHaveLength(0);
    expect(result.requirements[0]!.waitable).toHaveLength(3);
  });

  it('is read-only: calling twice returns equal results and mutates nothing on the inputs', () => {
    const u = usage();
    const before = JSON.stringify(u);
    const req: DispatchRequirement = { provider: undefined, reroutable: true, route: { kind: 'pool' } };
    const viabilityInput = input({ usage: u, requirements: [req] });
    const first = assessAccountViability(viabilityInput);
    const second = assessAccountViability(viabilityInput);
    expect(first).toEqual(second);
    expect(JSON.stringify(u)).toBe(before);
  });
});
