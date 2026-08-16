import { describe, expect, it } from 'vitest';
import { parseAgentRoute } from '@loki-labs/better-cezar-contract';
import {
  accountUsageKey,
  defaultAgentAccountUsageStore,
  recordDispatch,
  recordLimited,
  type AgentAccountUsageStore,
} from './agent-account-usage.ts';
import { POOL_QUOTA_CEILING, poolCandidates, selectPoolAccount } from './agent-route-select.ts';
import type { ResolvedAgentProfile } from './agent-profiles.ts';

/**
 * The pool balancer (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase C).
 *
 * Every test here names the signal it isolates, because the three of them are ordered and a bug in
 * the ordering looks exactly like a bug in any one of them: an account chosen for the wrong reason
 * is still an account, and the run succeeds either way. Nothing observable distinguishes "balanced"
 * from "always picked the first one" without asserting on the choice itself.
 */

const NOW = Date.parse('2026-08-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

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

const CLAUDE_A = profile('claude', 'default');
const CLAUDE_B = profile('claude', 'work');
const CODEX = profile('codex', 'default');

const keyOf = (p: ResolvedAgentProfile) => accountUsageKey(p.provider, p.isDefault ? undefined : p.id);

function store(build: (s: AgentAccountUsageStore) => void = () => {}): AgentAccountUsageStore {
  const s = defaultAgentAccountUsageStore();
  build(s);
  return s;
}

const pick = (
  candidates: readonly ResolvedAgentProfile[],
  s: AgentAccountUsageStore,
  inflight: Record<string, number> = {},
) => selectPoolAccount({ candidates, store: s, inflight, now: NOW });

describe('candidates', () => {
  it('a provider pool takes only that provider', () => {
    expect(poolCandidates(parseAgentRoute('pool:claude'), [CLAUDE_A, CLAUDE_B, CODEX])).toEqual([
      CLAUDE_A,
      CLAUDE_B,
    ]);
  });

  it('the everything pool takes every provider', () => {
    expect(poolCandidates(parseAgentRoute('pool:*'), [CLAUDE_A, CLAUDE_B, CODEX])).toHaveLength(3);
  });

  it('an account route has no candidates at all', () => {
    // Not "all of them" — an account route must never reach the balancer, and returning everything
    // here would make a specific-account choice silently balance.
    expect(poolCandidates(parseAgentRoute('work'), [CLAUDE_A, CLAUDE_B])).toEqual([]);
  });
});

describe('signal 1 — skip a limited account', () => {
  it('routes around the limited login', () => {
    const s = store((x) => recordLimited(x, keyOf(CLAUDE_A), { source: 'test' }, new Date(NOW)));
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('uses an account again once its stated limit has passed', () => {
    const s = store((x) =>
      recordLimited(x, keyOf(CLAUDE_B), { source: 'test', until: ago(60_000) }, new Date(NOW - 3_600_000)),
    );
    // B is the better pick on every other signal; the expired limit must not keep excluding it.
    recordDispatch(s, keyOf(CLAUDE_A), new Date(NOW - 1_000));
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('still returns an account when every candidate is limited', () => {
    // Returning undefined would push the caller into inventing a fallback, and the natural
    // invention ("use the default") ignores the limits entirely. Picking the least-recently-used
    // limited account fails the same way the run would have anyway, without a silent detour.
    const s = store((x) => {
      recordLimited(x, keyOf(CLAUDE_A), { source: 'test' }, new Date(NOW));
      recordLimited(x, keyOf(CLAUDE_B), { source: 'test' }, new Date(NOW));
      recordDispatch(x, keyOf(CLAUDE_A), new Date(NOW - 1_000));
      recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 60_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('prefers ANY unlimited account over a limited one, even a busier, staler one', () => {
    // Signal 1 is a filter, not a tiebreak: it must beat both later signals at once.
    const s = store((x) => {
      recordLimited(x, keyOf(CLAUDE_A), { source: 'test' }, new Date(NOW));
      recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 1_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s, { [keyOf(CLAUDE_B)]: 5 })?.accountId).toBe('work');
  });
});

describe('signal 2 — fewest in-flight', () => {
  it('picks the idle account over the busy one', () => {
    expect(pick([CLAUDE_A, CLAUDE_B], store(), { [keyOf(CLAUDE_A)]: 2 })?.accountId).toBe('work');
  });

  it('beats the dispatch cursor', () => {
    // A just-dispatched-but-idle account is a better target than a long-idle-but-busy one: signal 2
    // describes NOW, signal 3 describes the past. Mutation: swap the two comparisons and this flips.
    const s = store((x) => recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 1_000)));
    expect(pick([CLAUDE_A, CLAUDE_B], s, { [keyOf(CLAUDE_A)]: 3 })?.accountId).toBe('work');
  });

  it('counts each provider\'s discovered login separately', () => {
    // Both are the id `default`; only the provider-qualified key keeps them apart. Keyed on the id
    // alone, claude's 3 in-flight would exclude codex's idle login from the everything pool.
    expect(pick([CLAUDE_A, CODEX], store(), { [keyOf(CLAUDE_A)]: 3 })?.provider).toBe('codex');
  });
});

describe('signal 3 — least recently dispatched', () => {
  it('spreads over accounts that are otherwise identical', () => {
    const s = store((x) => recordDispatch(x, keyOf(CLAUDE_A), new Date(NOW - 1_000)));
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('a never-dispatched account goes first', () => {
    const s = store((x) => recordDispatch(x, keyOf(CLAUDE_A), new Date(NOW - 86_400_000)));
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('actually alternates over repeated dispatches', () => {
    // The behavioural test, and the one a "return candidates[0]" implementation cannot fake: run the
    // real loop the way the dispatcher does, recording each choice, and assert the SPREAD.
    const s = store();
    const picked: string[] = [];
    for (let i = 0; i < 6; i++) {
      const choice = selectPoolAccount({ candidates: [CLAUDE_A, CLAUDE_B], store: s, now: NOW + i * 1_000 });
      picked.push(choice!.accountId);
      recordDispatch(s, accountUsageKey('claude', choice!.accountId), new Date(NOW + i * 1_000));
    }
    expect(picked).toEqual(['default', 'work', 'default', 'work', 'default', 'work']);
  });

  it('reads an unparseable timestamp as never dispatched, not as just now', () => {
    // The failure mode of the other reading is permanent exclusion from the rotation.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { dispatch: { lastAt: 'not a date', count: 1 } };
      recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 60_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('default');
  });
});

describe('quota refines, never decides', () => {
  const quota = (usedPercent: number) => ({
    takenAt: new Date(NOW).toISOString(),
    windows: [{ usedPercent, windowMinutes: 300, resetsAt: Math.floor(NOW / 1000) + 3600 }],
  });

  it('sorts an exhausted account last', () => {
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(POOL_QUOTA_CEILING) };
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('uses an exhausted account anyway when it is the only one', () => {
    // Sorting last, not excluding: the number may be minutes old and the window may have rolled.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(100) };
    });
    expect(pick([CLAUDE_A], s)?.accountId).toBe('default');
  });

  it('ignores a STALE exhausted reading', () => {
    // `freshQuota` drops it, so it must not sort the account down. A balancer that acted on stale
    // quota would keep avoiding an account whose window refilled hours ago.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = {
        quota: { takenAt: ago(3_600_000), windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(NOW / 1000) + 3600 }] },
      };
      recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 1_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('default');
  });

  it('is exhausted when ANY window is, not when the average is', () => {
    // A fresh 5h window beside an exhausted weekly one is exactly the case an average would hide.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = {
        quota: {
          takenAt: new Date(NOW).toISOString(),
          windows: [
            { usedPercent: 1, windowMinutes: 300, resetsAt: Math.floor(NOW / 1000) + 3600 },
            { usedPercent: 99, windowMinutes: 10_080, resetsAt: Math.floor(NOW / 1000) + 86_400 },
          ],
        },
      };
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('balances with no quota anywhere, which is every Claude-only machine', () => {
    // The negative control for the whole quota branch: a balancer that NEEDED quota would not work
    // for Claude, and Claude is where most of these accounts are.
    const s = store((x) => recordDispatch(x, keyOf(CLAUDE_A), new Date(NOW - 1_000)));
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });
});

describe('degenerate input', () => {
  it('returns undefined for an empty pool rather than inventing an account', () => {
    expect(selectPoolAccount({ candidates: [], store: store(), now: NOW })).toBeUndefined();
  });

  it('reports the discovered account as the reserved id, not as its slug', () => {
    expect(pick([CLAUDE_A], store())).toEqual({ provider: 'claude', accountId: 'default' });
  });

  it('reports a stored account by its own id', () => {
    expect(pick([CLAUDE_B], store())).toEqual({ provider: 'claude', accountId: 'work' });
  });
});
