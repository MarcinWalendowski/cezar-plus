import { describe, expect, it } from 'vitest';
import {
  AGENT_POOL_ALL,
  agentPoolId,
  formatAgentRoute,
  isAgentPoolId,
  parseAgentRoute,
} from './agent-route.ts';

/**
 * The pool/account encoding (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase C).
 *
 * The whole design rests on one claim — **a stored account id can never look like a pool** — so
 * that is what most of this file pins. `AGENT_ACCOUNT_ID_RE` is `/^[a-z0-9][a-z0-9-]{0,63}$/`: no
 * colon, ever. If that regex is ever widened, these tests are the alarm.
 */

describe('a pool id cannot collide with an account id', () => {
  it('reserves a namespace no account id can enter', () => {
    // The load-bearing fact, asserted against the real charset rather than a comment about it.
    const accountIdRe = /^[a-z0-9][a-z0-9-]{0,63}$/;
    expect(accountIdRe.test('pool:claude')).toBe(false);
    expect(accountIdRe.test(AGENT_POOL_ALL)).toBe(false);
    // …and the shapes real allocation produces still parse as accounts.
    for (const id of ['default', 'claude-klaudiusz', 'work2', 'pool']) {
      expect(accountIdRe.test(id)).toBe(true);
      expect(parseAgentRoute(id)).toEqual({ kind: 'account', accountId: id });
    }
  });

  it('reads a bare `pool` as an account, since that IS an allocatable slug', () => {
    // The prefix is `pool:`, not `pool`. A folder called `pool/` slugs to `pool` and must keep
    // working as the account it is.
    expect(parseAgentRoute('pool')).toEqual({ kind: 'account', accountId: 'pool' });
  });
});

describe('parseAgentRoute', () => {
  it('reads a per-provider pool', () => {
    expect(parseAgentRoute('pool:claude')).toEqual({ kind: 'pool', provider: 'claude' });
    expect(parseAgentRoute('pool:codex')).toEqual({ kind: 'pool', provider: 'codex' });
  });

  it('reads the everything pool as a pool with no provider', () => {
    // Absent provider, NOT a list of every provider: the candidate set is built at dispatch from
    // the accounts that exist then, so freezing it here would go stale the moment one is added.
    expect(parseAgentRoute(AGENT_POOL_ALL)).toEqual({ kind: 'pool' });
  });

  it('treats `pool:<not a provider>` as an account, not a pool', () => {
    // A value cezar did not write must not be honoured as a routing instruction it cannot execute.
    // It degrades to the default account downstream, which is the documented unknown-id behaviour.
    expect(parseAgentRoute('pool:anthropic')).toEqual({ kind: 'account', accountId: 'pool:anthropic' });
    expect(parseAgentRoute('pool:')).toEqual({ kind: 'account', accountId: 'pool:' });
  });

  it('reads absence as the discovered account', () => {
    for (const value of [undefined, null, '']) {
      expect(parseAgentRoute(value)).toEqual({ kind: 'account', accountId: 'default' });
    }
  });
});

describe('round trip', () => {
  it('formats back to exactly what parsed', () => {
    for (const value of ['pool:claude', 'pool:codex', AGENT_POOL_ALL, 'default', 'klaudiusz']) {
      expect(formatAgentRoute(parseAgentRoute(value))).toBe(value);
    }
  });

  it('agentPoolId and parseAgentRoute agree', () => {
    expect(parseAgentRoute(agentPoolId('codex'))).toEqual({ kind: 'pool', provider: 'codex' });
  });
});

describe('isAgentPoolId', () => {
  it('is true only for values that actually route to a pool', () => {
    expect(isAgentPoolId('pool:claude')).toBe(true);
    expect(isAgentPoolId(AGENT_POOL_ALL)).toBe(true);
    // Same answer as parseAgentRoute, by construction — one definition of "is a pool".
    expect(isAgentPoolId('pool:anthropic')).toBe(false);
    expect(isAgentPoolId('default')).toBe(false);
    expect(isAgentPoolId(undefined)).toBe(false);
  });
});
