import { describe, expect, it } from 'vitest';
import { parseAgentRoute } from '@loki-labs/cezar-plus-contract';
import {
  accountUsageKey,
  defaultAgentAccountUsageStore,
  recordDispatch,
  recordLimited,
  type AgentAccountUsageStore,
} from './agent-account-usage.ts';
import { poolCandidates, selectPoolAccount } from './agent-route-select.ts';
import type { ResolvedAgentProfile } from './agent-profiles.ts';

/**
 * The pool balancer (`.ai/specs/2026-08-16-agent-account-usage-routing.md`, Phase C).
 *
 * Every test here names the signal it isolates, because the four of them are ordered and a bug in
 * the ordering looks exactly like a bug in any one of them: an account chosen for the wrong reason
 * is still an account, and the run succeeds either way. Nothing observable distinguishes "balanced"
 * from "always picked the first one" without asserting on the choice itself.
 *
 * The signal numbering matches the module's docblock: limited → usage band → in-flight → dispatch
 * cursor. Band ordering arrived 2026-08-16 in place of a 95% binary ceiling; see that docblock.
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
const CODEX_B = profile('codex', 'secondary');

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
    // Signal 1 is a filter, not a tiebreak: it must beat every later signal at once.
    const s = store((x) => {
      recordLimited(x, keyOf(CLAUDE_A), { source: 'test' }, new Date(NOW));
      recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 1_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s, { [keyOf(CLAUDE_B)]: 5 })?.accountId).toBe('work');
  });
});

describe('signal 2 is confined to one provider (spec 2026-08-24, D2)', () => {
  const window = (usedPercent: number, minutes = 10_080) => ({
    usedPercent,
    windowMinutes: minutes,
    resetsAt: Math.floor(NOW / 1000) + 3600,
  });
  const quota = (...windows: ReturnType<typeof window>[]) => ({
    takenAt: new Date(NOW).toISOString(),
    windows,
  });

  it('still steers between two logins of the SAME provider', () => {
    // The partition must not be a way of switching signal 2 off. An unmeasured codex account is in
    // the pool — under the old whole-set rule that alone disabled banding for everyone — and the
    // two Claude logins must still prefer the emptier one.
    // Mutation: compute `byBand` over the whole pool again and this comes back as 'default'.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(74)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(4)) };
    });
    expect(pick([CLAUDE_A, CLAUDE_B, CODEX], s)?.accountId).toBe('work');
  });

  it('never lets a codex band out-rank a claude account', () => {
    // THE test for D2, and the production case: codex reported 0% while it was five days into a
    // weekly refusal, so it sorted band 0 against Claude's band 7 and won every comparison. This
    // asserts the rule even when the codex reading is REAL — the point is not that codex lies, it
    // is that two subscriptions' percentages are not the same quantity.
    //
    // Codex is given the more recent dispatch so signal 4 decides against it; under the old
    // cross-provider band it wins anyway, which is what makes this mutation-sensitive.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(94)) };
      x.accounts[keyOf(CODEX)] = { quota: quota(window(0, 300)) };
      recordDispatch(x, keyOf(CODEX), new Date(NOW - 1_000));
    });
    expect(pick([CLAUDE_A, CODEX], s)).toEqual({ provider: 'claude', accountId: 'default' });
  });

  it('alternates two unmeasured codex logins — the case the second account was added for', () => {
    // Neither codex account can report a band on a ChatGPT Plus plan (see `looksUnpopulated` in
    // `core/agent-account-probe.ts`), so the pool has only signals 3 and 4 to work with. Strict
    // alternation is what those two produce, and it is the whole balancing guarantee available
    // between two codex logins.
    const s = store();
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const choice = selectPoolAccount({ candidates: [CODEX, CODEX_B], store: s, now: NOW + i });
      picked.push(choice!.accountId);
      recordDispatch(s, accountUsageKey('codex', choice!.accountId), new Date(NOW + i));
    }
    expect(picked).toEqual(['default', 'secondary', 'default', 'secondary']);
  });

  it('alternates across providers once each provider has its winner', () => {
    // Level 2 compares the per-provider winners on in-flight then the dispatch cursor, so a mixed
    // `pool:*` spreads across providers instead of pinning to whichever one reports a number.
    // Claude's own winner is still chosen by band: `work` at 4% beats `default` at 74%, and it is
    // the id that must appear here — not `default`.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(74)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(4)) };
    });
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const choice = selectPoolAccount({ candidates: [CLAUDE_A, CLAUDE_B, CODEX], store: s, now: NOW + i });
      picked.push(`${choice!.provider}:${choice!.accountId}`);
      recordDispatch(s, accountUsageKey(choice!.provider, choice!.accountId), new Date(NOW + i));
    }
    expect(picked).toEqual(['claude:work', 'codex:default', 'claude:work', 'codex:default']);
  });

  it('does not depend on the order the candidates arrive in', () => {
    // The reason D2 is two levels rather than a "same provider?" clause inside `compare`: that
    // clause is intransitive (A beats B, B ties C, C ties A), and an intransitive comparator makes
    // `reduce` return whatever sorts first in the input. Same set, reversed — same answer.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(90)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(10)) };
      recordDispatch(x, keyOf(CODEX), new Date(NOW - 1_000));
    });
    const forwards = pick([CLAUDE_A, CLAUDE_B, CODEX], s);
    const backwards = pick([CODEX, CLAUDE_B, CLAUDE_A], s);
    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual({ provider: 'claude', accountId: 'work' });
  });
});

describe('signal 3 — fewest in-flight', () => {
  it('picks the idle account over the busy one', () => {
    expect(pick([CLAUDE_A, CLAUDE_B], store(), { [keyOf(CLAUDE_A)]: 2 })?.accountId).toBe('work');
  });

  it('beats the dispatch cursor', () => {
    // A just-dispatched-but-idle account is a better target than a long-idle-but-busy one: signal 3
    // describes NOW, signal 4 describes the past. Mutation: swap the two comparisons and this flips.
    const s = store((x) => recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 1_000)));
    expect(pick([CLAUDE_A, CLAUDE_B], s, { [keyOf(CLAUDE_A)]: 3 })?.accountId).toBe('work');
  });

  it('counts each provider\'s discovered login separately', () => {
    // Both are the id `default`; only the provider-qualified key keeps them apart. Keyed on the id
    // alone, claude's 3 in-flight would exclude codex's idle login from the everything pool.
    expect(pick([CLAUDE_A, CODEX], store(), { [keyOf(CLAUDE_A)]: 3 })?.provider).toBe('codex');
  });
});

describe('signal 4 — least recently dispatched', () => {
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

/**
 * Signal 2, rewritten 2026-08-16. It used to be a boolean — `usedPercent >= 95` sorts last — and
 * the block was called "quota refines, never decides". It refined nothing: the machine that
 * prompted this had one Claude login at 66% of its week and another at 9%, a difference the
 * boolean could not see, so signals 3 and 4 alternated between them all day. The band is what
 * makes a measured difference visible without letting a number that re-polls every 15 seconds
 * dictate the whole order.
 */
describe('signal 2 — the usage band', () => {
  const window = (usedPercent: number, minutes = 300) => ({
    usedPercent,
    windowMinutes: minutes,
    resetsAt: Math.floor(NOW / 1000) + 3600,
  });
  const quota = (...windows: ReturnType<typeof window>[]) => ({
    takenAt: new Date(NOW).toISOString(),
    windows,
  });

  it('sends the run to the less-used login, and keeps sending it there', () => {
    // THE test, and the measured case: `claude · Default` at 66% of its week, `owner`
    // at 9%, nothing running on either. Under the retired 95% ceiling both read "fine", so the
    // dispatch cursor alternated and the gap never closed. Mutation: restore the binary ceiling and
    // this comes back as ['default', 'work', 'default', ...].
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(66, 10_080)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(9, 10_080)) };
    });
    const picked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const choice = selectPoolAccount({ candidates: [CLAUDE_A, CLAUDE_B], store: s, now: NOW + i });
      picked.push(choice!.accountId);
      recordDispatch(s, accountUsageKey('claude', choice!.accountId), new Date(NOW + i));
    }
    expect(picked).toEqual(['work', 'work', 'work', 'work']);
  });

  it('lets in-flight decide INSIDE a band', () => {
    // 62% and 66% are the same band, so the live signal decides — that is the point of banding
    // rather than ordering on the raw percent. Two mutations turn this red, and they are the two
    // ways to get this wrong: drop `inflight` from `compare` (falls through to the cursor, and A
    // has never been dispatched, so A wins), or compare raw percent (A's 62 < B's 66, so A wins).
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(62)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(66)) };
      recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 1_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s, { [keyOf(CLAUDE_A)]: 2 })?.accountId).toBe('work');
  });

  it('does not reorder at all when even one candidate is unmeasured', () => {
    // A measured account and an unmeasured one are not comparable by usage. The tempting default —
    // unmeasured sorts best — hands every run to whichever login the probe happens to be failing
    // on, which is the opposite of balancing. So the key switches off for the whole set and the
    // pool balances the way it did before quota existed: B is busy, so A wins despite its 90%.
    // Mutation: let an unmeasured account sort as band 0 and B wins.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(90)) };
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s, { [keyOf(CLAUDE_B)]: 1 })?.accountId).toBe('default');
  });

  it('reads a quota whose windows have ALL rolled over as unmeasured, not as 0%', () => {
    // `freshQuota` drops rolled-over windows and answers `undefined` once none are left. Reading
    // that as 0% would put the account in the BEST band on the strength of a window that expired —
    // and `Math.max()` of an empty list is `-Infinity`, i.e. better than every measured account.
    //
    // A is that account, and it is ALSO the one the cursor should route away from, which is what
    // makes the assertion non-vacuous: correct ⇒ no band ordering ⇒ B wins on the cursor; mutated
    // to read A as 0% ⇒ A is band 0 against B's band 3 and takes the run.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = {
        quota: { takenAt: new Date(NOW).toISOString(), windows: [{ usedPercent: 5, windowMinutes: 300, resetsAt: Math.floor(NOW / 1000) - 60 }] },
      };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(30)) };
      recordDispatch(x, keyOf(CLAUDE_A), new Date(NOW - 1_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('ignores a STALE reading', () => {
    // `freshQuota` drops the whole snapshot on age, so it must not band the account at all. A
    // balancer that acted on stale quota would keep avoiding an account whose window refilled hours
    // ago.
    //
    // B carries a FRESH 30% precisely so the mutation has somewhere to go: drop the staleness check
    // and A's stale 100% bands it at 10, behind B, which is the permanent avoidance this guards
    // against. Correct behaviour is that A is unmeasured, bands switch off, and the cursor — which
    // just sent a run to B — picks A.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = {
        quota: { takenAt: ago(3_600_000), windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: Math.floor(NOW / 1000) + 3600 }] },
      };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(30)) };
      recordDispatch(x, keyOf(CLAUDE_B), new Date(NOW - 1_000));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('default');
  });

  it('bands on the WORST window, not the average', () => {
    // Being out of ANY window stops the account, so the max is the number that matters. The
    // percentages are chosen so the two readings disagree: max puts A in band 9 and B in band 6, so
    // B wins; averaging A to 50 would put it in band 5 and hand the run to the account with an
    // almost-exhausted week.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(1), window(99, 10_080)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(60)) };
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('still returns an account when every candidate is exhausted', () => {
    // Sorting last, never excluding. The number may be minutes old and the window may have rolled;
    // the run then fails and re-arms the limit, which is what would have happened anyway.
    // Mutation: filter on the band instead of sorting by it, and this returns undefined.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(100)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(104)) };
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('default');
    // And the pool of one, which is where an exclusion would return nothing at all.
    expect(pick([CLAUDE_A], s)?.accountId).toBe('default');
  });

  it('is still beaten by signal 1 — a limited account is skipped whatever its band', () => {
    // The limited account is the emptiest one here (5% vs 90%), so a band ordering placed above the
    // limited filter picks it and the run fails on a login cezar already knows is rate-limited.
    // Mutation: move `limited` below the band in `compare` and this flips to 'default'.
    const s = store((x) => {
      x.accounts[keyOf(CLAUDE_A)] = { quota: quota(window(5)) };
      x.accounts[keyOf(CLAUDE_B)] = { quota: quota(window(90)) };
      recordLimited(x, keyOf(CLAUDE_A), { source: 'test' }, new Date(NOW));
    });
    expect(pick([CLAUDE_A, CLAUDE_B], s)?.accountId).toBe('work');
  });

  it('balances with no quota anywhere, which is every unprobed cockpit', () => {
    // The negative control for the whole quota branch. With `CEZ_ACCOUNT_USAGE` off, or the panel
    // closed so nothing polls, NOTHING is measured — and the balancer must degrade to exactly its
    // pre-quota behaviour rather than to a stable arbitrary favourite.
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
