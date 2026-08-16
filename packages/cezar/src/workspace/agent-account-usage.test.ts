import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentAccountUsagePath } from '../paths.ts';
import {
  ASSUMED_LIMIT_COOLDOWN_MS,
  QUOTA_STALE_AFTER_MS,
  accountUsageKey,
  clearLimited,
  countInflight,
  defaultAgentAccountUsageStore,
  freshQuota,
  isLimited,
  loadAgentAccountUsage,
  mergeWriteAgentAccountUsage,
  recordDispatch,
  recordLimited,
  usageEntry,
} from './agent-account-usage.ts';

/**
 * `~/.cezar/agent-account-usage.json` (spec `2026-08-16-agent-account-usage-routing.md`).
 *
 * The tests worth reading are the ones about *not* believing a number: a rolled-over quota window
 * that is seconds old, and a limit with no stated end. Both look fine and both are wrong.
 */
describe('agent account usage store', () => {
  const originalHome = process.env.CEZ_HOME;
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-usage-'));
    process.env.CEZ_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('keying', () => {
    it('does not pool two providers’ discovered logins into one bucket', () => {
      // The reserved `default` id belongs to EVERY provider at once, so keying on it alone would
      // add Claude's in-flight runs to Codex's and let one provider's rate-limit exclude the other.
      expect(accountUsageKey('claude')).not.toBe(accountUsageKey('codex'));
      expect(accountUsageKey('claude')).toBe('claude:default');
      expect(accountUsageKey('codex', undefined)).toBe('codex:default');
    });

    it('treats an empty-string account id as the discovered default', () => {
      expect(accountUsageKey('claude', '')).toBe('claude:default');
      expect(accountUsageKey('claude', null)).toBe('claude:default');
    });

    it('keeps a stored account distinct from its provider’s default', () => {
      expect(accountUsageKey('claude', 'work')).toBe('claude:work');
      expect(accountUsageKey('claude', 'work')).not.toBe(accountUsageKey('claude'));
    });
  });

  describe('in-flight counting', () => {
    it('counts only running steps, per account', () => {
      const counts = countInflight([
        { backend: 'claude', profileId: 'work', status: 'running' },
        { backend: 'claude', profileId: 'work', status: 'running' },
        { backend: 'claude', status: 'running' },
        { backend: 'codex', status: 'running' },
        { backend: 'claude', profileId: 'work', status: 'done' },
        { backend: 'claude', profileId: 'work', status: 'failed' },
      ]);
      expect(counts).toEqual({ 'claude:work': 2, 'claude:default': 1, 'codex:default': 1 });
    });

    it('skips a step with no backend rather than guessing one', () => {
      // Pre-affinity runs.json rows have no `backend`. Attributing them would move a real count
      // onto an account that may never have run them.
      expect(countInflight([{ profileId: 'work', status: 'running' }])).toEqual({});
    });

    it('returns nothing when nothing is running — the post-crash answer', () => {
      // The whole reason in-flight is derived: a persisted counter would still read 1 here.
      expect(countInflight([{ backend: 'claude', status: 'done' }])).toEqual({});
    });
  });

  describe('quota freshness', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');
    const live = Math.floor(now / 1000) + 3600;

    it('keeps a recent snapshot whose window has not reset', () => {
      const quota = {
        takenAt: new Date(now - 30_000).toISOString(),
        planType: 'pro',
        windows: [{ usedPercent: 43, windowMinutes: 300, resetsAt: live }],
      };
      expect(freshQuota(quota, now)?.windows).toHaveLength(1);
    });

    it('drops the whole snapshot once it is older than the staleness ceiling', () => {
      const quota = {
        takenAt: new Date(now - QUOTA_STALE_AFTER_MS - 1_000).toISOString(),
        windows: [{ usedPercent: 43, windowMinutes: 300, resetsAt: live }],
      };
      expect(freshQuota(quota, now)).toBeUndefined();
    });

    it('drops a window that has already reset, even in a seconds-old snapshot', () => {
      // The subtle one: recent AND wrong at the same time. The window refilled, so its
      // `usedPercent` describes a window that no longer exists, and no age check can see it.
      const quota = {
        takenAt: new Date(now - 1_000).toISOString(),
        windows: [
          { usedPercent: 98, windowMinutes: 300, resetsAt: Math.floor(now / 1000) - 60 },
          { usedPercent: 7, windowMinutes: 10_080, resetsAt: live },
        ],
      };
      const fresh = freshQuota(quota, now);
      expect(fresh?.windows).toEqual([{ usedPercent: 7, windowMinutes: 10_080, resetsAt: live }]);
    });

    it('returns undefined rather than an empty window list', () => {
      // An empty list would render as a bar with nothing in it — read as "0% used".
      const quota = {
        takenAt: new Date(now - 1_000).toISOString(),
        windows: [{ usedPercent: 98, windowMinutes: 300, resetsAt: Math.floor(now / 1000) - 60 }],
      };
      expect(freshQuota(quota, now)).toBeUndefined();
    });

    it('has nothing to report for an account no provider gave a quota for', () => {
      // Absent, never zero — the state every account is in before its first probe lands.
      expect(freshQuota(undefined, now)).toBeUndefined();
    });

    it('keeps a window that states no reset time at all', () => {
      // Claude's shape: a percentage and a human string, no epoch — and on an idle window, not even
      // that. The obvious spelling of the rollover filter (`window.resetsAt * 1000 > now`) reads the
      // absence as `NaN > now`, which is false, so it drops EVERY Claude window and leaves the
      // snapshot empty. That failure is invisible: it looks exactly like a provider that reports
      // nothing, which is the state this whole feature exists to end.
      const quota = {
        takenAt: new Date(now - 30_000).toISOString(),
        windows: [
          { usedPercent: 66, label: 'week', resetsText: 'Aug 20 at 1am (Europe/Warsaw)' },
          { usedPercent: 0, label: 'session' },
        ],
      };
      expect(freshQuota(quota, now)?.windows).toHaveLength(2);
    });

    it('still drops a rolled-over window that DOES state its reset', () => {
      // The other half of the same guard: widening it for Claude must not switch rollover off for
      // Codex. A stated reset in the past still expires that window, in the same snapshot as an
      // unstated one that survives.
      const quota = {
        takenAt: new Date(now - 1_000).toISOString(),
        windows: [
          { usedPercent: 98, windowMinutes: 300, resetsAt: Math.floor(now / 1000) - 60 },
          { usedPercent: 0, label: 'session' },
        ],
      };
      expect(freshQuota(quota, now)?.windows).toEqual([{ usedPercent: 0, label: 'session' }]);
    });

    it('drops a snapshot with an unparseable timestamp', () => {
      const quota = { takenAt: 'not-a-date', windows: [{ usedPercent: 1, windowMinutes: 300, resetsAt: live }] };
      expect(freshQuota(quota, now)).toBeUndefined();
    });
  });

  describe('limit windows', () => {
    const now = Date.parse('2026-08-16T12:00:00.000Z');

    it('honours a provider-stated reset time', () => {
      const until = new Date(now + 60_000).toISOString();
      expect(isLimited({ since: new Date(now).toISOString(), until, source: 'run-error' }, now)).toBe(true);
      expect(isLimited({ since: new Date(now).toISOString(), until, source: 'run-error' }, now + 61_000)).toBe(false);
    });

    it('bounds a limit the provider did not put an end on', () => {
      // Unbounded would deadlock: skipped by the balancer, so never run, so never succeeds, so
      // never cleared. The account must become eligible again on its own.
      const since = new Date(now).toISOString();
      expect(isLimited({ since, source: 'run-error' }, now + 1_000)).toBe(true);
      expect(isLimited({ since, source: 'run-error' }, now + ASSUMED_LIMIT_COOLDOWN_MS + 1)).toBe(false);
    });

    it('reads a corrupt date as not limited', () => {
      // Trying a working login and failing costs one run; excluding it on a corrupt string is
      // indefinite and invisible.
      expect(isLimited({ since: 'nonsense', source: 'run-error' }, now)).toBe(false);
      expect(isLimited({ since: 'nonsense', until: 'nonsense', source: 'run-error' }, now)).toBe(false);
    });

    it('is not limited when nothing was recorded', () => {
      expect(isLimited(undefined, now)).toBe(false);
    });
  });

  describe('mutations', () => {
    it('increments the dispatch cursor', () => {
      let store = defaultAgentAccountUsageStore();
      store = recordDispatch(store, 'claude:work', new Date('2026-08-16T10:00:00.000Z'));
      store = recordDispatch(store, 'claude:work', new Date('2026-08-16T10:05:00.000Z'));
      expect(usageEntry(store, 'claude:work').dispatch).toEqual({
        lastAt: '2026-08-16T10:05:00.000Z',
        count: 2,
      });
    });

    it('records a limit and clears it on success', () => {
      let store = defaultAgentAccountUsageStore();
      store = recordLimited(store, 'claude:work', { source: 'run-error' }, new Date('2026-08-16T10:00:00.000Z'));
      expect(usageEntry(store, 'claude:work').limited?.source).toBe('run-error');
      store = clearLimited(store, 'claude:work');
      expect(usageEntry(store, 'claude:work').limited).toBeUndefined();
    });

    it('keeps the dispatch cursor when a limit is recorded and cleared', () => {
      // Clearing a limit must not reset fairness, or a limited account jumps the queue on recovery.
      let store = defaultAgentAccountUsageStore();
      store = recordDispatch(store, 'claude:work', new Date('2026-08-16T10:00:00.000Z'));
      store = recordLimited(store, 'claude:work', { source: 'run-error' });
      store = clearLimited(store, 'claude:work');
      expect(usageEntry(store, 'claude:work').dispatch?.count).toBe(1);
    });

    it('omits `until` when the provider did not state one', () => {
      const store = recordLimited(defaultAgentAccountUsageStore(), 'claude:work', { source: 'run-error' });
      expect(usageEntry(store, 'claude:work').limited).not.toHaveProperty('until');
    });
  });

  describe('file behaviour', () => {
    it('reads back what it wrote', async () => {
      await mergeWriteAgentAccountUsage((store) => recordDispatch(store, 'codex:default'));
      const loaded = await loadAgentAccountUsage();
      expect(usageEntry(loaded, 'codex:default').dispatch?.count).toBe(1);
    });

    it('is the zero-config default when the file is absent', async () => {
      expect((await loadAgentAccountUsage()).accounts).toEqual({});
    });

    it('degrades a corrupt file to empty, warns once, and leaves it on disk', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      writeFileSync(agentAccountUsagePath(), '{not json');
      expect((await loadAgentAccountUsage()).accounts).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      // Left for the user to repair; the next successful merge-write replaces it.
      expect(readFileSync(agentAccountUsagePath(), 'utf8')).toBe('{not json');
    });

    it('salvages the good rows when one entry is junk', async () => {
      writeFileSync(
        agentAccountUsagePath(),
        JSON.stringify({
          version: 1,
          accounts: {
            'claude:work': { dispatch: { lastAt: '2026-08-16T10:00:00.000Z', count: 3 } },
            'claude:bad': 'not-an-object',
          },
        }),
      );
      const loaded = await loadAgentAccountUsage();
      expect(usageEntry(loaded, 'claude:work').dispatch?.count).toBe(3);
      expect(loaded.accounts['claude:bad']).toBeUndefined();
    });

    it('drops a malformed quota window without losing the rest of the entry', async () => {
      writeFileSync(
        agentAccountUsagePath(),
        JSON.stringify({
          version: 1,
          accounts: {
            'codex:default': {
              dispatch: { lastAt: '2026-08-16T10:00:00.000Z', count: 1 },
              quota: {
                takenAt: '2026-08-16T10:00:00.000Z',
                windows: [{ usedPercent: 'lots', windowMinutes: 300, resetsAt: 1 }, { usedPercent: 5, windowMinutes: 300, resetsAt: 2 }],
              },
            },
          },
        }),
      );
      const entry = usageEntry(await loadAgentAccountUsage(), 'codex:default');
      expect(entry.dispatch?.count).toBe(1);
      expect(entry.quota?.windows).toEqual([{ usedPercent: 5, windowMinutes: 300, resetsAt: 2 }]);
    });

    it('preserves an unknown key written by a newer cezar', async () => {
      writeFileSync(
        agentAccountUsagePath(),
        JSON.stringify({ version: 1, accounts: { 'claude:work': { futureField: 42 } }, futureTop: 'keep' }),
      );
      await mergeWriteAgentAccountUsage((store) => recordDispatch(store, 'codex:default'));
      const raw = JSON.parse(readFileSync(agentAccountUsagePath(), 'utf8'));
      expect(raw.futureTop).toBe('keep');
      expect(raw.accounts['claude:work'].futureField).toBe(42);
    });

    it('never throws when the home cannot be written', async () => {
      // A lost write costs one dispatch's fairness, not a user's configuration — so unlike the
      // accounts file this degrades instead of failing the run that triggered it.
      process.env.CEZ_HOME = join(home, 'nope', 'deeper');
      await expect(mergeWriteAgentAccountUsage((store) => recordDispatch(store, 'codex:default'))).resolves.toBeDefined();
    });
  });
});
