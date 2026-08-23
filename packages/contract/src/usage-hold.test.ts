import { describe, expect, it } from 'vitest';
import { accountUsageKey, runAccountKey, usageHoldAccountKey } from './usage-hold.ts';

describe('accountUsageKey', () => {
  it('carries the provider, so two discovered logins are two accounts', () => {
    expect(accountUsageKey('claude')).toBe('claude:default');
    expect(accountUsageKey('codex')).toBe('codex:default');
    expect(accountUsageKey('claude', 'secondary')).toBe('claude:secondary');
    // An empty id is the discovered default, not an account named ''.
    expect(accountUsageKey('claude', '')).toBe('claude:default');
  });
});

describe('runAccountKey — where the work WILL run', () => {
  it('reads the run record, falling back to the configured default runner', () => {
    expect(runAccountKey({ runner: 'codex' }, 'claude')).toBe('codex:default');
    expect(runAccountKey({}, 'codex')).toBe('codex:default');
    expect(runAccountKey({ runner: 'claude', agentProfile: 'secondary' }, 'claude')).toBe('claude:secondary');
  });
});

describe('usageHoldAccountKey — which account was actually refused', () => {
  it('names the failing STEP\'s account, not the run\'s own runner', () => {
    // The production record (prod-host, run 76680e19, 2026-08-23): created on codex, but
    // `spec-to-deploy` pins `review-spec` to claude, and that is where the weekly limit landed.
    // Reading the run instead put a Claude limit on `codex:default`.
    const run = {
      runner: 'codex' as const,
      agentProfile: 'default',
      steps: [
        { status: 'done', backend: 'claude' as const, profileId: 'secondary' },
        { status: 'failed', backend: 'claude' as const, profileId: 'default' },
      ],
    };
    expect(usageHoldAccountKey(run, 'claude')).toBe('claude:default');
  });

  it('prefers the failed step even when a later step ran on another account', () => {
    const run = {
      runner: 'claude' as const,
      steps: [
        { status: 'failed', backend: 'claude' as const, profileId: 'default' },
        { status: 'running', backend: 'codex' as const, profileId: 'default' },
      ],
    };
    expect(usageHoldAccountKey(run, 'claude')).toBe('claude:default');
  });

  it('falls back to the newest stamped step when nothing failed — the in-flight resume', () => {
    const run = {
      runner: 'codex' as const,
      steps: [
        { status: 'done', backend: 'claude' as const, profileId: 'secondary' },
        { status: 'running', backend: 'claude' as const, profileId: 'default' },
      ],
    };
    expect(usageHoldAccountKey(run, 'codex')).toBe('claude:default');
  });

  it('falls back to the run record only when no step names a backend', () => {
    // Records written before backend affinity, and a run that failed before any step started.
    expect(usageHoldAccountKey({ runner: 'codex', steps: [{ status: 'pending' }] }, 'claude')).toBe('codex:default');
    expect(usageHoldAccountKey({ steps: [] }, 'claude')).toBe('claude:default');
    expect(usageHoldAccountKey({}, 'codex')).toBe('codex:default');
  });
});
